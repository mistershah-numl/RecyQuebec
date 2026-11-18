"""
RECYC-Contact-OSINT — local worker (Windows / VS Code friendly)

Endpoints
  GET  /            -> health
  GET  /health      -> health
  POST /render      -> fetch one URL with a real browser (beats Cloudflare/JS sites)
  POST /osint       -> full-context OSINT on a company
  POST /verify      -> reverse-verify an email/phone against a company (no AI)
  POST /smtp/test   -> open a real SMTP session and log in (connection test)
  POST /smtp/send   -> send one email through the configured SMTP server

Run:
  py -3.12 -m venv .venv
  .\\.venv\\Scripts\\Activate.ps1
  pip install -r requirements.txt
  python -m playwright install chromium
  $env:WORKER_SECRET="shah"
  uvicorn main:app --host 0.0.0.0 --port 8000
"""

import asyncio
import os
import re
import smtplib
import socket
import ssl
import sys
import time
import unicodedata

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
from contextlib import asynccontextmanager, suppress
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from playwright.async_api import async_playwright

WORKER_SECRET = os.environ.get("WORKER_SECRET", "shah")
HEADLESS = os.environ.get("HEADLESS", "1") != "0"
NAV_TIMEOUT = int(os.environ.get("NAV_TIMEOUT_MS", "35000"))
MAX_BROWSER_PAGES = max(1, min(8, int(os.environ.get("MAX_BROWSER_PAGES", "3"))))
RENDER_TIMEOUT = max(10, min(90, int(os.environ.get("RENDER_TIMEOUT_SECONDS", "30"))))
OSINT_TIMEOUT = max(30, min(300, int(os.environ.get("OSINT_TIMEOUT_SECONDS", "90"))))
SMTP_TIMEOUT = max(10, min(120, int(os.environ.get("SMTP_TIMEOUT_SECONDS", "30"))))
MAX_OSINT_BROWSER_FALLBACKS = max(0, min(6, int(os.environ.get("MAX_OSINT_BROWSER_FALLBACKS", "2"))))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})")
EXEC_TITLE_RE = re.compile(
    r"\b(Président|Présidente|Directeur Général|Directrice Générale|Fondateur|Fondatrice|Propriétaire|CEO|President|Owner)\b",
    re.IGNORECASE,
)
LEGAL_SUFFIX_RE = re.compile(r"\b(INC|INCORPOREE|LTEE|LIMITEE|CORP|CORPORATION|ENR|SENC|SNC|CIE|COMPANY|CO)\b\.?", re.I)

BAD_EMAIL_HINTS = (
    "example.com", "sentry.io", "wixpress.com", "godaddy.com", "schema.org",
    "domain.com", "email.com", ".png", ".jpg", ".jpeg", ".svg", ".webp", "@2x",
)
BAD_HOSTS = ("duckduckgo.com", "google.", "bing.com", "yahoo.", "mojeek.com", "search.brave.com")
CANADA_RE = re.compile(
    r"\b(canada|canadian|qu[ée]bec|quebec|montr[ée]al|montreal|ottawa|toronto|vancouver|calgary|"
    r"edmonton|winnipeg|halifax|saskatoon|regina|new brunswick|nova scotia|ontario|alberta|"
    r"british columbia|manitoba|saskatchewan|pei|newfoundland|yukon|nunavut|northwest territories|"
    r"[A-Z]\d[A-Z][ -]?\d[A-Z]\d)\b",
    re.IGNORECASE,
)
FOREIGN_LOCATION_RE = re.compile(
    r"\b(france|paris|lyon|marseille|belgique|belgium|suisse|switzerland|united kingdom|"
    r"royaume-uni|australia|australie|united states|[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b",
    re.IGNORECASE,
)

try:
    from playwright_stealth import Stealth
    _STEALTH_V2 = Stealth()
    _STEALTH_V1 = None
except Exception:
    _STEALTH_V2 = None
    try:
        from playwright_stealth import stealth_async as _STEALTH_V1
    except Exception:
        _STEALTH_V1 = None


# ---------------------------------------------------------------- lifecycle
async def launch_browser(app: FastAPI):
    return await app.state.pw.chromium.launch(
        headless=HEADLESS,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
        ],
    )


async def ensure_browser(app: FastAPI):
    if app.state.browser and app.state.browser.is_connected():
        return
    async with app.state.browser_lock:
        if app.state.browser and app.state.browser.is_connected():
            return
        if getattr(app.state, "pw", None) is None:
            app.state.pw = await async_playwright().start()
        with suppress(Exception):
            if app.state.browser:
                await app.state.browser.close()
        app.state.browser = await launch_browser(app)
        app.state.stats["restarts"] += 1


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pw = None
    app.state.browser = None
    app.state.browser_lock = asyncio.Lock()
    app.state.lock = asyncio.Semaphore(MAX_BROWSER_PAGES)
    app.state.stats = {
        "active": 0, "queued": 0, "completed": 0, "failed": 0, "restarts": 0,
        "emails_sent": 0, "emails_failed": 0, "started_at": time.time()
    }

    loop = asyncio.get_running_loop()
    previous_exception_handler = loop.get_exception_handler()

    def _playwright_exception_handler(event_loop, context):
        exc = context.get("exception")
        message = str(exc or context.get("message", ""))
        if "Target page, context or browser has been closed" in message or "net::ERR_ABORTED" in message:
            app.state.stats["cancelled_navigations"] = app.state.stats.get("cancelled_navigations", 0) + 1
            return
        if previous_exception_handler:
            previous_exception_handler(event_loop, context)
        else:
            event_loop.default_exception_handler(context)

    loop.set_exception_handler(_playwright_exception_handler)

    # Warm up browser asynchronously so FastAPI server starts serving immediately
    asyncio.create_task(ensure_browser(app))

    yield
    if app.state.browser:
        with suppress(Exception):
            await app.state.browser.close()
    if getattr(app.state, "pw", None):
        with suppress(Exception):
            await app.state.pw.stop()


app = FastAPI(title="RECYC-Contact-OSINT Worker", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=True,
    allow_methods=["*"], allow_headers=["*"],
)


def verify_auth(secret: Optional[str]):
    if WORKER_SECRET and secret != WORKER_SECRET:
        raise HTTPException(status_code=401, detail="Unauthorized: invalid worker secret")


@app.get("/")
@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "recyc-osint-worker",
        "headless": HEADLESS,
        "stealth": _STEALTH_V2 is not None or _STEALTH_V1 is not None,
        "browser_connected": bool(app.state.browser and app.state.browser.is_connected()),
        "max_browser_pages": MAX_BROWSER_PAGES,
        "render_timeout_seconds": RENDER_TIMEOUT,
        "osint_timeout_seconds": OSINT_TIMEOUT,
        "smtp": True,
        **app.state.stats,
    }


# ---------------------------------------------------------------- /render
class RenderIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    url: str
    wait_ms: int = 1200
    wait_selector: Optional[str] = None


@app.post("/render")
async def render(body: RenderIn, x_worker_secret: Optional[str] = Header(None)):
    verify_auth(x_worker_secret)
    app.state.stats["queued"] += 1
    try:
        return await asyncio.wait_for(_render_impl(body), timeout=RENDER_TIMEOUT)
    except asyncio.TimeoutError:
        app.state.stats["failed"] += 1
        return {"ok": False, "status": 0, "url": body.url, "error": f"render deadline exceeded ({RENDER_TIMEOUT}s)", "html": "", "text": ""}
    finally:
        app.state.stats["queued"] = max(0, app.state.stats["queued"] - 1)


async def _render_impl(body: RenderIn):
    async with app.state.lock:
        app.state.stats["active"] += 1
        context = None
        page = None
        try:
            await ensure_browser(app)
            context = await app.state.browser.new_context(
                user_agent=UA,
                locale="en-CA",
                timezone_id="America/Toronto",
                viewport={"width": 1366, "height": 900},
                extra_http_headers={
                    "Accept-Language": "en-CA,en;q=0.9,fr-CA;q=0.8,fr;q=0.7",
                    "Upgrade-Insecure-Requests": "1",
                },
            )
            page = await context.new_page()
            page.set_default_timeout(NAV_TIMEOUT)
            page.set_default_navigation_timeout(NAV_TIMEOUT)
            if _STEALTH_V2:
                await _STEALTH_V2.apply_stealth_async(page)
            elif _STEALTH_V1:
                await _STEALTH_V1(page)

            async def _block_media(route):
                if route.request.resource_type in ("image", "media", "font"):
                    await route.abort()
                else:
                    await route.continue_()

            await page.route("**/*", _block_media)

            resp = await page.goto(body.url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
            status = resp.status if resp else 0

            for _ in range(12):
                html_check = await page.content()
                title_check = (await page.title()) or ""
                if ("Just a moment" not in title_check
                        and "cf-challenge" not in html_check
                        and "challenge-platform" not in html_check):
                    break
                await page.wait_for_timeout(1000)

            for selector in ["text=Show email", "text=Show phone", "text=Reveal",
                             "text=Afficher", "button:has-text('email')", "button:has-text('contact')"]:
                try:
                    btn = page.locator(selector).first
                    if await btn.count() > 0 and await btn.is_visible():
                        await btn.click(timeout=1500)
                        await page.wait_for_timeout(400)
                except Exception:
                    pass

            if body.wait_selector:
                try:
                    await page.wait_for_selector(body.wait_selector, timeout=5000)
                except Exception:
                    pass

            await page.wait_for_timeout(body.wait_ms)
            html = await page.content()
            text = await page.evaluate("() => document.body ? document.body.innerText : ''")
            app.state.stats["completed"] += 1
            return {"ok": True, "status": status, "url": page.url, "html": html, "text": text}
        except asyncio.CancelledError:
            app.state.stats["failed"] += 1
            raise
        except Exception as e:
            app.state.stats["failed"] += 1
            return {"ok": False, "status": 0, "url": body.url, "error": str(e), "html": "", "text": ""}
        finally:
            if page:
                with suppress(Exception):
                    await page.unroute_all(behavior="wait")
                with suppress(Exception):
                    await asyncio.wait_for(page.close(), timeout=5)
            if context:
                with suppress(Exception):
                    await asyncio.wait_for(context.close(), timeout=5)
            app.state.stats["active"] = max(0, app.state.stats["active"] - 1)


# ---------------------------------------------------------------- helpers
async def fetch_text(url: str, wait_ms: int = 900, allow_browser: bool = True) -> Dict[str, str]:
    try:
        async with httpx.AsyncClient(
            timeout=15, follow_redirects=True,
            headers={"User-Agent": UA, "Accept-Language": "fr-CA,fr;q=0.9,en-CA;q=0.8"},
        ) as client:
            r = await client.get(url)
            if r.status_code < 400 and len(r.text) > 800 and "Just a moment" not in r.text:
                return {"html": r.text, "url": str(r.url)}
    except Exception:
        pass
    if not allow_browser:
        return {"html": "", "url": url}
    out = await render(RenderIn(url=url, wait_ms=wait_ms), x_worker_secret=WORKER_SECRET or None)
    return {"html": out.get("html", ""), "url": out.get("url", url)}


def plain(html: str) -> str:
    return BeautifulSoup(html, "html.parser").get_text(" ", strip=True)


def deaccent(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def clean_emails(raw: List[str]) -> List[str]:
    seen, cleaned = set(), []
    for e in raw:
        e = e.strip().strip(".,;:)'\"").lower()
        if any(b in e for b in BAD_EMAIL_HINTS) or "@" not in e or len(e) > 80 or e in seen:
            continue
        seen.add(e)
        cleaned.append(e)
    return cleaned


def norm_phone(m) -> str:
    return f"({m.group(1)}) {m.group(2)}-{m.group(3)}"


def mx_ok(domain: str) -> bool:
    try:
        import dns.resolver
        return len(dns.resolver.resolve(domain, "MX", lifetime=4)) > 0
    except Exception:
        try:
            socket.gethostbyname(domain)
            return True
        except Exception:
            return False


async def search(engine_url: str, link_filter=None) -> List[str]:
    # Search-result pages are ordinary HTML. Never spend a scarce Chromium slot
    # on them: at 200+ rows that causes nested /osint -> /render fan-out and can
    # starve every active company behind the same semaphore.
    page = await fetch_text(engine_url, allow_browser=False)
    soup = BeautifulSoup(page["html"], "html.parser")
    links: List[str] = []
    for a in soup.select("a[href]"):
        href = a["href"]
        if "//duckduckgo.com/l/?uddg=" in href:
            full = "https:" + href if href.startswith("//") else href
            href = unquote(parse_qs(urlparse(full).query).get("uddg", [""])[0])
        if not href.startswith("http"):
            continue
        if link_filter and not link_filter(href):
            continue
        if href not in links:
            links.append(href)
    return links[:25]


def company_tokens(name: str) -> List[str]:
    base = LEGAL_SUFFIX_RE.sub(" ", deaccent(name))
    return [t for t in re.split(r"[^a-z0-9]+", base) if len(t) >= 4]


def mentions_company(text: str, tokens: List[str], neq: Optional[str], domain: Optional[str]) -> bool:
    t = deaccent(text)
    if neq and neq.lower() in t:
        return True
    if domain and domain.lower() in t:
        return True
    if not tokens:
        return False
    return sum(1 for tok in tokens if tok in t) >= min(2, len(tokens))


def canada_match(text: str, url: str = "") -> bool:
    """Require positive Canadian evidence; a neutral .com alone is not evidence."""
    host = urlparse(url).netloc.lower()
    return host.endswith(".ca") or bool(CANADA_RE.search(text))


def trusted_company_page(text: str, url: str, company: str, neq: Optional[str], domain: Optional[str] = None) -> bool:
    if not text or not mentions_company(text, company_tokens(company), neq, domain):
        return False
    if not canada_match(text, url):
        return False
    # A foreign location is acceptable only when the same page has an explicit
    # Canadian marker. This prevents similarly named French Facebook profiles.
    return not FOREIGN_LOCATION_RE.search(text) or bool(CANADA_RE.search(text))


async def reverse_check(value: str, kind: str, company: str, neq: Optional[str],
                        domain: Optional[str]) -> Dict[str, Any]:
    """Search the literal email/phone and see which business the web attaches it to."""
    tokens = company_tokens(company)
    digits = re.sub(r"\D", "", value)
    confirmations, unrelated, sources, notes = 0, 0, [], []

    queries = [f'"{value}"']
    if kind == "phone" and len(digits) >= 10:
        d = digits[-10:]
        queries.append(f'"{d[:3]}-{d[3:6]}-{d[6:]}"')

    links: List[str] = []
    for q in queries:
        try:
            hits = await search(
                f"https://duckduckgo.com/html/?q={quote_plus(q)}",
                lambda h: not any(b in h for b in BAD_HOSTS),
            )
            for h in hits:
                if h not in links:
                    links.append(h)
        except Exception as e:
            notes.append(f"search failed: {e}")

    for url in links[:6]:
        try:
            # Reverse checks are corroboration, not a reason to monopolize a
            # browser slot. Blocked pages are skipped and other sources remain.
            r = await fetch_text(url, wait_ms=800, allow_browser=False)
            text = plain(r["html"])
        except Exception:
            continue
        has_value = value.lower() in text.lower() or (
            kind == "phone" and len(digits) >= 10 and digits[-10:] in re.sub(r"\D", "", text)
        )
        if not has_value:
            continue
        host = urlparse(url).netloc.replace("www.", "").lower()
        company_match = mentions_company(text, tokens, neq, domain) or (domain and host == domain)
        if company_match and canada_match(text, url):
            confirmations += 1
            sources.append(host)
            notes.append(f"{host} publishes it together with the company")
        elif company_match:
            notes.append(f"{host} names the company but has no Canadian location evidence")
        else:
            unrelated += 1
            notes.append(f"{host} publishes it but never names the company")

    return {
        "value": value,
        "kind": kind,
        "confirmations": confirmations,
        "unrelated": unrelated,
        "matched": confirmations > 0,
        "conflicting": confirmations == 0 and unrelated >= 2,
        "sources": sources,
        "notes": notes,
    }


# ---------------------------------------------------------------- /verify
class VerifyIn(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    value: str
    kind: str = "email"
    company: str = Field("", alias="company_name")
    neq: Optional[str] = None
    domain: Optional[str] = None


@app.post("/verify")
async def verify(body: VerifyIn, x_worker_secret: Optional[str] = Header(None)):
    verify_auth(x_worker_secret)
    result = await reverse_check(body.value, body.kind, body.company, body.neq, body.domain)
    if body.kind == "email" and "@" in body.value:
        result["mx"] = mx_ok(body.value.split("@")[-1])
    return {"ok": True, **result}


# ---------------------------------------------------------------- /osint
class OsintIn(BaseModel):
    # extra="ignore" + both field names accepted -> never returns 422
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    company: str = Field("", alias="company_name")
    company_name: Optional[str] = None
    neq: Optional[str] = None
    city: Optional[str] = None
    province: Optional[str] = "Quebec"
    country: Optional[str] = "Canada"
    domain: Optional[str] = None
    extra_sites: List[str] = []
    sites: List[str] = []
    max_pages: int = 8


@app.post("/osint")
async def osint(body: OsintIn, x_worker_secret: Optional[str] = Header(None)):
    verify_auth(x_worker_secret)
    try:
        return await asyncio.wait_for(_osint_impl(body), timeout=OSINT_TIMEOUT)
    except asyncio.TimeoutError:
        app.state.stats["failed"] += 1
        return {"ok": False, "error": f"company deadline exceeded ({OSINT_TIMEOUT}s)", "emails": [], "phones": [], "people": [], "socials": {}, "log": ["worker deadline reached; app will retry this company"]}


async def _osint_impl(body: OsintIn):

    company_name = (body.company or body.company_name or "").strip()
    if not company_name:
        return {"ok": False, "error": "company name missing", "emails": [], "phones": [],
                "people": [], "socials": {}, "log": ["no company name supplied"]}

    targets = list(dict.fromkeys([*(body.extra_sites or []), *(body.sites or [])]))

    log: List[str] = []
    emails: List[str] = []
    phones: List[str] = []
    people: List[Dict[str, str]] = []
    socials: Dict[str, str] = {}
    address: Optional[str] = None
    domain = body.domain
    browser_budget = MAX_OSINT_BROWSER_FALLBACKS

    async def osint_fetch(url: str, wait_ms: int = 900) -> Dict[str, str]:
        """Bound browser work per company so a blocked site cannot starve the queue."""
        nonlocal browser_budget
        direct = await fetch_text(url, wait_ms=wait_ms, allow_browser=False)
        if direct["html"] or browser_budget <= 0:
            return direct
        browser_budget -= 1
        return await fetch_text(url, wait_ms=wait_ms, allow_browser=True)

    clean_name = LEGAL_SUFFIX_RE.sub("", company_name).strip()
    city_str = body.city or ""
    q_base = f'"{clean_name}" {city_str} {body.province or ""} {body.country or ""}'.strip()

    # 1. official domain
    if not domain:
        log.append(f"searching official domain for '{clean_name}'")
        urls = await search(
            f"https://duckduckgo.com/html/?q={quote_plus(q_base + ' site officiel OR official website')}",
            lambda h: not any(s in h for s in (*BAD_HOSTS, "facebook.com", "linkedin.com", "yellowpages.ca")),
        )
        for u in urls[:5]:
            host = urlparse(u).netloc.lower().replace("www.", "")
            candidate_page = await osint_fetch(u, wait_ms=500)
            candidate_text = plain(candidate_page["html"])
            if host and "." in host and trusted_company_page(candidate_text, u, company_name, body.neq, None):
                domain = host
                log.append(f"validated Canadian domain: {domain}")
                break

    # 2. crawl the site
    if domain:
        base = f"https://{domain}"
        pages = [base]
        home = await osint_fetch(base)
        soup = BeautifulSoup(home["html"], "html.parser")
        for a in soup.select("a[href]"):
            t = (a.get_text() or "").lower() + " " + a["href"].lower()
            if any(k in t for k in ("contact", "about", "propos", "equipe", "team", "direction", "nous", "joindre")):
                pages.append(urljoin(base, a["href"]))

        seen = set()
        for p in pages:
            if p in seen or len(seen) >= body.max_pages:
                continue
            seen.add(p)
            r = await osint_fetch(p)
            page_soup = BeautifulSoup(r["html"], "html.parser")
            txt = page_soup.get_text(" ", strip=True)
            emails += EMAIL_RE.findall(r["html"])
            phones += [norm_phone(m) for m in PHONE_RE.finditer(txt)]
            for tag in page_soup.find_all(["p", "div", "h2", "h3", "li", "span"]):
                tag_text = tag.get_text(" ", strip=True)
                if EXEC_TITLE_RE.search(tag_text) and len(tag_text) < 100:
                    people.append({"name": tag_text, "title": ""})
            for a in page_soup.select("a[href]"):
                h = a["href"]
                for net in ("linkedin.com", "facebook.com", "instagram.com", "x.com"):
                    if net in h and net not in socials:
                        socials[net] = h
            if not address:
                m = re.search(
                    r"\d{1,5}[^,\n]{3,60},\s*[A-Za-zÀ-ÿ\-\s']{2,40},?\s*(QC|Qu[ée]bec|ON)[^,\n]{0,20}[A-Z]\d[A-Z]\s?\d[A-Z]\d",
                    txt)
                if m:
                    address = m.group(0)
            log.append(f"crawled {p} ({len(emails)} emails so far)")

    # 3. directories / socials
    for site, key in [("linkedin.com/company", "linkedin.com"),
                      ("facebook.com", "facebook.com"),
                      ("b2bhint.com", "b2bhint.com")]:
        if key in socials:
            continue
        try:
            found = await search(
                f"https://duckduckgo.com/html/?q={quote_plus(f'site:{site} {clean_name} {city_str}'.strip())}",
                lambda h, s=site.split("/")[0]: s in h,
            )
            for candidate_url in found[:3]:
                candidate = await osint_fetch(candidate_url, wait_ms=500)
                candidate_text = plain(candidate["html"])
                if trusted_company_page(candidate_text, candidate_url, company_name, body.neq, domain):
                    socials[key] = candidate_url
                    log.append(f"validated Canadian {key}: {candidate_url}")
                    break
            if found and key not in socials:
                log.append(f"{key}: rejected search results without Canadian company match")
        except Exception as e:
            log.append(f"{key} search failed: {e}")

    # 4. user target sites
    for extra in targets:
        try:
            hits = await search(f"https://duckduckgo.com/html/?q={quote_plus(f'site:{extra} {clean_name}')}")
            for u in hits[:2]:
                r = await osint_fetch(u, wait_ms=1000)
                txt = plain(r["html"])
                if not trusted_company_page(txt, u, company_name, body.neq, domain):
                    log.append(f"extra site rejected (company/Canada mismatch): {u}")
                    continue
                emails += EMAIL_RE.findall(txt)
                phones += [norm_phone(m) for m in PHONE_RE.finditer(txt)]
                log.append(f"extra site {extra}: {u}")
        except Exception as e:
            log.append(f"extra site {extra} failed: {e}")

    # 5. clean + prioritise
    emails = clean_emails(emails)
    if domain:
        emails.sort(key=lambda e: 0 if e.endswith("@" + domain) else 1)
    phones = list(dict.fromkeys(phones))[:5]
    verified_mx = {e: mx_ok(e.split("@")[-1]) for e in emails[:10]}

    # 6. reverse cross-check: does the web tie these back to THIS company?
    cross: Dict[str, Any] = {}

    async def check_identifier(value: str, kind: str):
        try:
            rc = await reverse_check(value, kind, company_name, body.neq, domain)
            return value, rc, None
        except Exception as ex:
            return value, None, ex

    checks = await asyncio.gather(
        *(check_identifier(e, "email") for e in emails[:8]),
        *(check_identifier(p, "phone") for p in phones[:3]),
    )
    for value, rc, error in checks:
        if rc:
            cross[value] = rc
            log.append(f"reverse {value}: {rc['confirmations']} confirming, {rc['unrelated']} unrelated")
        elif error:
            log.append(f"reverse {value} failed: {error}")

    # drop identifiers the web clearly attaches to a different business
    emails = [e for e in emails if not cross.get(e, {}).get("conflicting")]
    phones = [p for p in phones if not cross.get(p, {}).get("conflicting")]
    emails.sort(key=lambda e: (-cross.get(e, {}).get("confirmations", 0), 0 if domain and e.endswith("@" + domain) else 1))
    trusted_emails = [e for e in emails if cross.get(e, {}).get("matched") or (domain and e.endswith("@" + domain))]

    return {
        "ok": True,
        "domain": domain,
        "emails": emails[:10],
        "trusted_emails": trusted_emails[:10],
        "email_mx": verified_mx,
        "phones": phones,
        "people": people[:5],
        "address": address,
        "socials": socials,
        "linkedin": socials.get("linkedin.com"),
        "facebook": socials.get("facebook.com"),
        "cross_check": cross,
        "trail": log[-20:],
        "log": log,
    }


# ---------------------------------------------------------------- SMTP email
class SmtpBase(BaseModel):
    """Connection settings pushed by the app (API Settings -> SMTP delivery)."""
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    host: str = ""
    port: int = 587
    security: str = "starttls"          # "ssl" | "starttls" | "none"
    username: Optional[str] = None
    password: Optional[str] = None
    from_email: str = ""
    from_name: Optional[str] = None
    reply_to: Optional[str] = None


class SmtpSendIn(SmtpBase):
    to: str = ""
    subject: str = ""
    text: str = ""
    html: str = ""


def _smtp_connect(cfg: SmtpBase):
    """Opens (and logs into) an SMTP session. Caller must quit() it."""
    host = (cfg.host or "").strip()
    if not host:
        raise ValueError("No SMTP host provided.")
    port = int(cfg.port or (465 if cfg.security == "ssl" else 587))
    security = (cfg.security or "starttls").lower()

    if security == "ssl":
        server = smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT, context=ssl.create_default_context())
    else:
        server = smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT)
        server.ehlo()
        if security == "starttls":
            server.starttls(context=ssl.create_default_context())
            server.ehlo()

    if cfg.username and cfg.password:
        server.login(cfg.username, cfg.password)
    return server


def _smtp_error_message(e: Exception) -> str:
    if isinstance(e, smtplib.SMTPAuthenticationError):
        return f"Login rejected by the server ({e.smtp_code}): {e.smtp_error.decode(errors='ignore') if isinstance(e.smtp_error, bytes) else e.smtp_error}"
    if isinstance(e, smtplib.SMTPRecipientsRefused):
        return f"Recipient refused: {e.recipients}"
    if isinstance(e, smtplib.SMTPSenderRefused):
        return f"Sender address refused: {e.sender}"
    if isinstance(e, smtplib.SMTPResponseException):
        detail = e.smtp_error.decode(errors="ignore") if isinstance(e.smtp_error, bytes) else e.smtp_error
        return f"SMTP error {e.smtp_code}: {detail}"
    if isinstance(e, (socket.timeout, TimeoutError)):
        return "The mail server did not answer in time. Check the host, port and firewall."
    if isinstance(e, ssl.SSLError):
        return f"TLS handshake failed: {e}. Try switching between STARTTLS (587) and SSL (465)."
    if isinstance(e, (ConnectionRefusedError, socket.gaierror, OSError)):
        return f"Could not connect to the mail server: {e}"
    return str(e)


def _do_smtp_test(cfg: SmtpBase) -> Dict[str, Any]:
    server = None
    try:
        server = _smtp_connect(cfg)
        try:
            server.noop()
        except Exception:
            pass
        who = f" as {cfg.username}" if cfg.username else " (no authentication)"
        return {"ok": True, "message": f"Connected to {cfg.host}:{cfg.port} over {cfg.security}{who}."}
    except Exception as e:
        return {"ok": False, "message": _smtp_error_message(e)}
    finally:
        if server:
            with suppress(Exception):
                server.quit()


def _do_smtp_send(cfg: SmtpSendIn) -> Dict[str, Any]:
    to = (cfg.to or "").strip()
    if not to or "@" not in to:
        return {"ok": False, "message": "No valid recipient address."}
    from_email = (cfg.from_email or cfg.username or "").strip()
    if not from_email:
        return {"ok": False, "message": "No sender address configured."}

    msg = EmailMessage()
    msg["Subject"] = cfg.subject or "(no subject)"
    msg["From"] = formataddr((cfg.from_name or "", from_email)) if cfg.from_name else from_email
    msg["To"] = to
    if cfg.reply_to:
        msg["Reply-To"] = cfg.reply_to
    msg["Message-ID"] = make_msgid(domain=from_email.split("@")[-1])
    body_text = cfg.text or BeautifulSoup(cfg.html or "", "html.parser").get_text("\n", strip=True)
    msg.set_content(body_text or " ")
    if cfg.html:
        msg.add_alternative(cfg.html, subtype="html")

    server = None
    try:
        server = _smtp_connect(cfg)
        server.send_message(msg)
        return {"ok": True, "message": f"Delivered to {to}."}
    except Exception as e:
        return {"ok": False, "message": _smtp_error_message(e)}
    finally:
        if server:
            with suppress(Exception):
                server.quit()


@app.post("/smtp/test")
async def smtp_test(body: SmtpBase, x_worker_secret: Optional[str] = Header(None)):
    """Opens a real SMTP session and logs in, so the app can prove the settings work."""
    verify_auth(x_worker_secret)
    try:
        return await asyncio.wait_for(asyncio.to_thread(_do_smtp_test, body), timeout=SMTP_TIMEOUT + 10)
    except asyncio.TimeoutError:
        return {"ok": False, "message": f"SMTP test timed out after {SMTP_TIMEOUT + 10}s."}


@app.post("/smtp/send")
async def smtp_send(body: SmtpSendIn, x_worker_secret: Optional[str] = Header(None)):
    """Sends one message. Runs in a thread so many campaign sends stay non-blocking."""
    verify_auth(x_worker_secret)
    try:
        result = await asyncio.wait_for(asyncio.to_thread(_do_smtp_send, body), timeout=SMTP_TIMEOUT + 20)
    except asyncio.TimeoutError:
        result = {"ok": False, "message": f"Sending timed out after {SMTP_TIMEOUT + 20}s."}
    app.state.stats["emails_sent" if result.get("ok") else "emails_failed"] += 1
    return result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

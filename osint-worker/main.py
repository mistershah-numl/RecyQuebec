"""
RECYC-Contact-OSINT — Local Worker Engine (Windows / VS Code / Production Ready)

Endpoints:
  GET  /            -> health & statistics
  GET  /health      -> health & statistics
  POST /render      -> fetch one URL with a real browser (beats Cloudflare/JS sites)
  POST /osint       -> comprehensive 9-stage OSINT + Reconnaissance on a company
  POST /verify      -> reverse-verify an email/phone against a company (no AI)
  POST /smtp/test   -> open a real SMTP session and log in (connection test)
  POST /smtp/send   -> send one email through the configured SMTP server

Run:
  py -3.12 -m venv .venv
  .\\.venv\\Scripts\\Activate.ps1
  pip install -r requirements.txt html2text
  python -m playwright install chromium
  $env:WORKER_SECRET="shah"
  uvicorn main:app --host 0.0.0.0 --port 8000
"""

import asyncio
import json
import os
import re
import smtplib
import socket
import ssl
import sys
import threading
import time
import unicodedata
from contextlib import asynccontextmanager, suppress
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import parse_qs, quote_plus, unquote, urljoin, urlparse

# Force Windows Proactor policy for async child processes (Playwright)
if sys.platform == "win32":
    _orig_set_policy = asyncio.set_event_loop_policy

    def _force_proactor_policy(policy):
        if isinstance(policy, asyncio.WindowsSelectorEventLoopPolicy):
            return
        _orig_set_policy(policy)

    asyncio.set_event_loop_policy = _force_proactor_policy
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

import html2text
import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from playwright.async_api import async_playwright

# ---------------------------------------------------------------- Configuration
WORKER_SECRET = os.environ.get("WORKER_SECRET", "shah")
HEADLESS = os.environ.get("HEADLESS", "1") != "0"
NAV_TIMEOUT = int(os.environ.get("NAV_TIMEOUT_MS", "35000"))
MAX_BROWSER_PAGES = max(1, min(8, int(os.environ.get("MAX_BROWSER_PAGES", "3"))))
RENDER_TIMEOUT = max(10, min(90, int(os.environ.get("RENDER_TIMEOUT_SECONDS", "30"))))
OSINT_TIMEOUT = max(30, min(300, int(os.environ.get("OSINT_TIMEOUT_SECONDS", "90"))))
SMTP_TIMEOUT = max(10, min(120, int(os.environ.get("SMTP_TIMEOUT_SECONDS", "30"))))
MAX_OSINT_BROWSER_FALLBACKS = max(0, min(6, int(os.environ.get("MAX_OSINT_BROWSER_FALLBACKS", "2"))))

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})")
EXEC_TITLE_RE = re.compile(
    r"\b(Président|Présidente|Directeur Général|Directrice Générale|DG|Fondateur|Fondatrice|Propriétaire|CEO|President|Owner|Directeur|Directrice|VP|Vice-Président)\b",
    re.IGNORECASE,
)
LEGAL_SUFFIX_RE = re.compile(
    r"\b(INC|INCORPOREE|INCORPORÉE|LTEE|LTÉE|LIMITEE|LIMITÉE|CORP|CORPORATION|ENR|SENC|S\.E\.N\.C|SNC|CIE|COMPANY|CO)\b\.?",
    re.I,
)

GENERIC_PREFIXES = (
    "info@", "contact@", "admin@", "support@", "service@", "services@",
    "ventes@", "sales@", "reception@", "facturation@", "billing@", "inquiry@"
)

BAD_EMAIL_HINTS = (
    "example.com", "sentry.io", "wixpress.com", "godaddy.com", "schema.org",
    "domain.com", "email.com", ".png", ".jpg", ".jpeg", ".svg", ".webp", "@2x",
    "cloudflare.com", "protection", "privacy", "whoisguard",
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

# Optional Stealth integration
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


# ---------------------------------------------------------------- Playwright Proactor Thread Runner
class PlaywrightLoopThread:
    """Dedicated background thread running a Windows ProactorEventLoop for Playwright."""
    def __init__(self):
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.thread: Optional[threading.Thread] = None

    def start(self):
        if self.thread is not None and self.thread.is_alive():
            return
        ready_event = threading.Event()

        def _worker():
            if sys.platform == "win32":
                asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
            self.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.loop)
            ready_event.set()
            self.loop.run_forever()

        self.thread = threading.Thread(target=_worker, daemon=True, name="PlaywrightProactorThread")
        self.thread.start()
        ready_event.wait()

    def run_coro(self, coro):
        self.start()
        future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return asyncio.wrap_future(future)

pw_thread = PlaywrightLoopThread()


# ---------------------------------------------------------------- Lifecycle & Server
async def launch_browser(app: FastAPI):
    if getattr(app.state, "pw", None) is None:
        app.state.pw = await async_playwright().start()
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
        "emails_sent": 0, "emails_failed": 0, "started_at": time.time(),
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

    pw_thread.start()
    with suppress(Exception):
        pw_thread.run_coro(ensure_browser(app))

    yield

    if app.state.browser:
        with suppress(Exception):
            pw_thread.run_coro(app.state.browser.close())
    if getattr(app.state, "pw", None):
        with suppress(Exception):
            pw_thread.run_coro(app.state.pw.stop())


app = FastAPI(title="RECYC-Contact-OSINT Worker", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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


# ---------------------------------------------------------------- /render Endpoint
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
        return await asyncio.wait_for(pw_thread.run_coro(_render_impl(body)), timeout=RENDER_TIMEOUT)
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

            # Interstitial check
            for _ in range(12):
                html_check = await page.content()
                title_check = (await page.title()) or ""
                if ("Just a moment" not in title_check
                        and "cf-challenge" not in html_check
                        and "challenge-platform" not in html_check):
                    break
                await page.wait_for_timeout(1000)

            # Click reveal buttons for emails/contacts
            for selector in [
                "text=Show email", "text=Show phone", "text=Reveal",
                "text=Afficher", "button:has-text('email')", "button:has-text('contact')",
            ]:
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
            text = clean_html_to_markdown(html)
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


# ---------------------------------------------------------------- Advanced OSINT & Clean Markdown Modules
def clean_html_to_markdown(raw_html: str) -> str:
    """Strips noisy layout tags, scripts, and attributes, returning clean structured Markdown."""
    if not raw_html:
        return ""
    try:
        soup = BeautifulSoup(raw_html, "html.parser")

        # 1. Decompose non-semantic and structural noise tags
        for noise_tag in soup(["script", "style", "nav", "header", "footer", "aside", "noscript", "svg", "form"]):
            noise_tag.decompose()

        # 2. Strip noise attributes, preserving essential references
        for tag in soup.find_all(True):
            tag.attrs = {key: val for key, val in tag.attrs.items() if key in ["href", "src"]}

        # 3. Convert to clean Markdown
        converter = html2text.HTML2Text()
        converter.ignore_links = False
        converter.ignore_images = True
        converter.bypass_tables = False
        converter.body_width = 0

        return converter.handle(str(soup))
    except Exception:
        return BeautifulSoup(raw_html, "html.parser").get_text(" ", strip=True)


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


# --- SpiderFoot Module: Passive DNS & Mail Infrastructure Profiling ---
async def spiderfoot_recon_domain(domain: str) -> Dict[str, Any]:
    """Inspects MX, SPF, TXT records to discover corporate mail vendors and aliases without sending packets."""
    recon = {"mx_records": [], "spf": None, "mail_provider": "Unknown"}
    try:
        import dns.resolver
        with suppress(Exception):
            mx_answers = dns.resolver.resolve(domain, "MX", lifetime=3)
            recon["mx_records"] = [str(r.exchange).strip(".") for r in mx_answers]
            mx_joined = " ".join(recon["mx_records"]).lower()
            if "google" in mx_joined or "aspmx" in mx_joined:
                recon["mail_provider"] = "Google Workspace"
            elif "outlook" in mx_joined or "protection.outlook" in mx_joined:
                recon["mail_provider"] = "Microsoft 365"
            elif "zoho" in mx_joined:
                recon["mail_provider"] = "Zoho Mail"
            elif "ovh" in mx_joined:
                recon["mail_provider"] = "OVHcloud"
        with suppress(Exception):
            txt_answers = dns.resolver.resolve(domain, "TXT", lifetime=3)
            for r in txt_answers:
                txt_data = b"".join(r.strings).decode("utf-8", errors="ignore")
                if "v=spf1" in txt_data:
                    recon["spf"] = txt_data
                    break
    except Exception:
        pass
    return recon


# --- theHarvester Module: Passive Search & Certificate Transparency Harvester ---
async def harvester_passive_discovery(domain: str, company_name: str) -> Tuple[List[str], List[str]]:
    """Mines public search indexes and certificate registries for unlisted emails and subdomains."""
    discovered_emails: List[str] = []
    discovered_subdomains: List[str] = []

    dork_query = quote_plus(f'site:{domain} "@{domain}"')
    dork_urls = await search(f"https://duckduckgo.com/html/?q={dork_query}", lambda h: not any(b in h for b in BAD_HOSTS))
    for url in dork_urls[:3]:
        r = await fetch_text(url, allow_browser=False)
        discovered_emails += EMAIL_RE.findall(r["html"])

    try:
        async with httpx.AsyncClient(timeout=6) as client:
            resp = await client.get(f"https://crt.sh/?q=%25.{domain}&output=json")
            if resp.status_code == 200:
                data = resp.json()
                for entry in data[:15]:
                    name_value = entry.get("name_value", "")
                    for sub in name_value.split("\n"):
                        sub = sub.strip().lower()
                        if sub.endswith(domain) and sub != domain and "*" not in sub:
                            if sub not in discovered_subdomains:
                                discovered_subdomains.append(sub)
    except Exception:
        pass

    return clean_emails(discovered_emails), discovered_subdomains[:8]


# --- Email Pattern Permutator Module ---
def generate_candidate_permutations(exec_name: str, domain: str) -> List[str]:
    """Generates standard corporate email candidates for executive names."""
    if not exec_name or not domain:
        return []
    clean = deaccent(exec_name)
    parts = [re.sub(r"[^a-z]", "", p) for p in clean.split() if len(p) >= 2]
    if len(parts) < 2:
        return [f"{parts[0]}@{domain}"] if parts else []

    first, last = parts[0], parts[-1]
    return [
        f"{first}.{last}@{domain}",
        f"{first[0]}{last}@{domain}",
        f"{first}@{domain}",
        f"{last}@{domain}",
        f"{first}{last}@{domain}",
        f"{first}_{last}@{domain}",
    ]


async def search(engine_url: str, link_filter=None) -> List[str]:
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
    host = urlparse(url).netloc.lower()
    return host.endswith(".ca") or bool(CANADA_RE.search(text))


def trusted_company_page(text: str, url: str, company: str, neq: Optional[str], domain: Optional[str] = None) -> bool:
    if not text or not mentions_company(text, company_tokens(company), neq, domain):
        return False
    if not canada_match(text, url):
        return False
    return not FOREIGN_LOCATION_RE.search(text) or bool(CANADA_RE.search(text))


async def reverse_check(value: str, kind: str, company: str, neq: Optional[str], domain: Optional[str]) -> Dict[str, Any]:
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
            r = await fetch_text(url, wait_ms=800, allow_browser=False)
            text = clean_html_to_markdown(r["html"])
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


# ---------------------------------------------------------------- /verify Endpoint
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


# ---------------------------------------------------------------- /osint Endpoint
class OsintIn(BaseModel):
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
        return {
            "ok": False,
            "error": f"company deadline exceeded ({OSINT_TIMEOUT}s)",
            "emails": [], "phones": [], "people": [], "socials": {},
            "log": ["worker deadline reached; app will retry this company"],
        }


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
        nonlocal browser_budget
        direct = await fetch_text(url, wait_ms=wait_ms, allow_browser=False)
        if direct["html"] or browser_budget <= 0:
            return direct
        browser_budget -= 1
        return await fetch_text(url, wait_ms=wait_ms, allow_browser=True)

    clean_name = LEGAL_SUFFIX_RE.sub("", company_name).strip()
    city_str = body.city or ""
    q_base = f'"{clean_name}" {city_str} {body.province or ""} {body.country or ""}'.strip()

    # 1. Official Domain Discovery
    if not domain:
        log.append(f"Searching official domain for '{clean_name}'")
        urls = await search(
            f"https://duckduckgo.com/html/?q={quote_plus(q_base + ' site officiel OR official website')}",
            lambda h: not any(s in h for s in (*BAD_HOSTS, "facebook.com", "linkedin.com", "yellowpages.ca")),
        )
        for u in urls[:5]:
            host = urlparse(u).netloc.lower().replace("www.", "")
            candidate_page = await osint_fetch(u, wait_ms=500)
            candidate_text = clean_html_to_markdown(candidate_page["html"])
            if host and "." in host and trusted_company_page(candidate_text, u, company_name, body.neq, None):
                domain = host
                log.append(f"Validated Canadian domain: {domain}")
                break

    # 2. SpiderFoot & theHarvester Recon Pass
    if domain:
        sf_info = await spiderfoot_recon_domain(domain)
        if sf_info["mail_provider"] != "Unknown":
            log.append(f"SpiderFoot: Identified infrastructure -> {sf_info['mail_provider']}")

        harvester_emails, subdomains = await harvester_passive_discovery(domain, clean_name)
        if harvester_emails:
            emails += harvester_emails
            log.append(f"theHarvester: Found {len(harvester_emails)} passive email targets")
        if subdomains:
            log.append(f"theHarvester: Mapped subdomains -> {', '.join(subdomains[:4])}")

    # 3. Crawl Target Site Sub-Pages (Render & Clean Markdown)
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
            
            # Clean page into structured Markdown
            markdown_content = clean_html_to_markdown(r["html"])
            
            emails += EMAIL_RE.findall(r["html"])
            phones += [norm_phone(m) for m in PHONE_RE.finditer(markdown_content)]

            # Extract named executives near hierarchy titles
            for line in markdown_content.splitlines():
                line_clean = line.strip()
                if EXEC_TITLE_RE.search(line_clean) and 10 < len(line_clean) < 90:
                    people.append({"name": line_clean, "title": ""})

            # Extract Social Handles
            page_soup = BeautifulSoup(r["html"], "html.parser")
            for a in page_soup.select("a[href]"):
                h = a["href"]
                for net in ("linkedin.com", "facebook.com", "instagram.com", "x.com"):
                    if net in h and net not in socials:
                        socials[net] = h

            if not address:
                m = re.search(
                    r"\d{1,5}[^,\n]{3,60},\s*[A-Za-zÀ-ÿ\-\s']{2,40},?\s*(QC|Qu[ée]bec|ON)[^,\n]{0,20}[A-Z]\d[A-Z]\s?\d[A-Z]\d",
                    markdown_content,
                )
                if m:
                    address = m.group(0)
            log.append(f"Crawled {p} (Found {len(emails)} emails so far)")

    # 4. Executive Pattern Candidate Permutations
    if domain and people:
        for p_entry in people[:3]:
            candidates = generate_candidate_permutations(p_entry["name"], domain)
            emails += candidates
            if candidates:
                log.append(f"Permutator: Generated candidates for {p_entry['name']}")

    # 5. Directories & Social Profile Discovery
    for site, key in [
        ("linkedin.com/company", "linkedin.com"),
        ("facebook.com", "facebook.com"),
        ("b2bhint.com", "b2bhint.com"),
    ]:
        if key in socials:
            continue
        try:
            found = await search(
                f"https://duckduckgo.com/html/?q={quote_plus(f'site:{site} {clean_name} {city_str}'.strip())}",
                lambda h, s=site.split("/")[0]: s in h,
            )
            for candidate_url in found[:3]:
                candidate = await osint_fetch(candidate_url, wait_ms=500)
                candidate_text = clean_html_to_markdown(candidate["html"])
                if trusted_company_page(candidate_text, candidate_url, company_name, body.neq, domain):
                    socials[key] = candidate_url
                    log.append(f"Validated Canadian {key}: {candidate_url}")
                    break
            if found and key not in socials:
                log.append(f"{key}: Rejected non-matching search results")
        except Exception as e:
            log.append(f"{key} search failed: {e}")

    # 6. User Custom Target Sites
    for extra in targets:
        try:
            hits = await search(f"https://duckduckgo.com/html/?q={quote_plus(f'site:{extra} {clean_name}')}")
            for u in hits[:2]:
                r = await osint_fetch(u, wait_ms=1000)
                txt = clean_html_to_markdown(r["html"])
                if not trusted_company_page(txt, u, company_name, body.neq, domain):
                    log.append(f"Extra site rejected (company mismatch): {u}")
                    continue
                emails += EMAIL_RE.findall(txt)
                phones += [norm_phone(m) for m in PHONE_RE.finditer(txt)]
                log.append(f"Extra site {extra}: {u}")
        except Exception as e:
            log.append(f"Extra site {extra} failed: {e}")

    # 7. Clean, Deduplicate & Prioritize Executive Personal vs. Generic Inboxes
    cleaned_all_emails = clean_emails(emails)
    
    exec_emails = []
    generic_emails = []
    for em in cleaned_all_emails:
        if any(em.startswith(p) for p in GENERIC_PREFIXES):
            generic_emails.append(em)
        else:
            exec_emails.append(em)

    if domain:
        exec_emails.sort(key=lambda e: 0 if e.endswith("@" + domain) else 1)
        generic_emails.sort(key=lambda e: 0 if e.endswith("@" + domain) else 1)

    emails = exec_emails + generic_emails
    phones = list(dict.fromkeys(phones))[:5]
    verified_mx = {e: mx_ok(e.split("@")[-1]) for e in emails[:10]}

    # 8. Reverse Cross-Check Engine
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
            log.append(f"Reverse check {value}: {rc['confirmations']} confirmed, {rc['unrelated']} unrelated")
        elif error:
            log.append(f"Reverse check {value} failed: {error}")

    emails = [e for e in emails if not cross.get(e, {}).get("conflicting")]
    phones = [p for p in phones if not cross.get(p, {}).get("conflicting")]
    emails.sort(
        key=lambda e: (
            -cross.get(e, {}).get("confirmations", 0),
            1 if any(e.startswith(p) for p in GENERIC_PREFIXES) else 0,
            0 if domain and e.endswith("@" + domain) else 1,
        )
    )
    trusted_emails = [
        e for e in emails
        if cross.get(e, {}).get("matched") or (domain and e.endswith("@" + domain))
    ]

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


# ---------------------------------------------------------------- SMTP Email Delivery Engine
class SmtpBase(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    host: str = ""
    port: int = 587
    security: str = "starttls"  # "ssl" | "starttls" | "none"
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
        return f"Login rejected ({e.smtp_code}): {e.smtp_error.decode(errors='ignore') if isinstance(e.smtp_error, bytes) else e.smtp_error}"
    if isinstance(e, smtplib.SMTPRecipientsRefused):
        return f"Recipient refused: {e.recipients}"
    if isinstance(e, smtplib.SMTPSenderRefused):
        return f"Sender address refused: {e.sender}"
    if isinstance(e, smtplib.SMTPResponseException):
        detail = e.smtp_error.decode(errors="ignore") if isinstance(e.smtp_error, bytes) else e.smtp_error
        return f"SMTP error {e.smtp_code}: {detail}"
    if isinstance(e, (socket.timeout, TimeoutError)):
        return "Mail server timeout. Check host, port and firewall settings."
    if isinstance(e, ssl.SSLError):
        return f"TLS handshake failed: {e}. Switch between STARTTLS (587) and SSL (465)."
    if isinstance(e, (ConnectionRefusedError, socket.gaierror, OSError)):
        return f"Could not connect to the mail server: {e}"
    return str(e)


def _do_smtp_test(cfg: SmtpBase) -> Dict[str, Any]:
    server = None
    try:
        server = _smtp_connect(cfg)
        with suppress(Exception):
            server.noop()
        who = f" as {cfg.username}" if cfg.username else " (unauthenticated)"
        return {"ok": True, "message": f"Connected successfully to {cfg.host}:{cfg.port} over {cfg.security}{who}."}
    except Exception as e:
        return {"ok": False, "message": _smtp_error_message(e)}
    finally:
        if server:
            with suppress(Exception):
                server.quit()


def _do_smtp_send(cfg: SmtpSendIn) -> Dict[str, Any]:
    to = (cfg.to or "").strip()
    if not to or "@" not in to:
        return {"ok": False, "message": "Invalid recipient address."}
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
    body_text = cfg.text or clean_html_to_markdown(cfg.html or "")
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
    verify_auth(x_worker_secret)
    try:
        return await asyncio.wait_for(asyncio.to_thread(_do_smtp_test, body), timeout=SMTP_TIMEOUT + 10)
    except asyncio.TimeoutError:
        return {"ok": False, "message": f"SMTP test timed out after {SMTP_TIMEOUT + 10}s."}


@app.post("/smtp/send")
async def smtp_send(body: SmtpSendIn, x_worker_secret: Optional[str] = Header(None)):
    verify_auth(x_worker_secret)
    try:
        result = await asyncio.wait_for(asyncio.to_thread(_do_smtp_send, body), timeout=SMTP_TIMEOUT + 20)
    except asyncio.TimeoutError:
        result = {"ok": False, "message": f"Sending timed out after {SMTP_TIMEOUT + 20}s."}
    app.state.stats["emails_sent" if result.get("ok") else "emails_failed"] += 1
    return result
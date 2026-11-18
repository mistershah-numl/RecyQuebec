"""
RECYC-Contact-OSINT — local worker (Windows / VS Code friendly)

Endpoints
  GET  /health   -> {"ok": true}
  POST /render   -> fetch one URL with a real browser (beats Cloudflare/JS sites)
  POST /osint    -> full-context OSINT on a company (pure-Python, no Kali needed)

Run:
  python -m venv .venv
  .venv\\Scripts\\activate
  pip install -r requirements.txt
  python -m playwright install chromium
  set WORKER_SECRET=shah
  uvicorn main:app --host 0.0.0.0 --port 8000
Then:  ngrok http 8000   -> paste the https URL in the app's API Settings.
"""

import asyncio
import os
import re
import socket
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional
from urllib.parse import quote_plus, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from playwright.async_api import async_playwright

WORKER_SECRET = os.environ.get("WORKER_SECRET", "shah")
HEADLESS = os.environ.get("HEADLESS", "1") != "0"
USER_DATA_DIR = os.environ.get("USER_DATA_DIR", os.path.abspath("./.pw-profile"))
NAV_TIMEOUT = int(os.environ.get("NAV_TIMEOUT_MS", "45000"))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})")
BAD_EMAIL_HINT = ("example.com", "sentry", "wixpress", "godaddy", ".png", ".jpg", "@2x")

# optional stealth (v1 or v2 API)
try:
    from playwright_stealth import Stealth  # v2
    _STEALTH_V2 = Stealth()
    _STEALTH_V1 = None
except Exception:  # pragma: no cover
    _STEALTH_V2 = None
    try:
        from playwright_stealth import stealth_async as _STEALTH_V1  # v1
    except Exception:
        _STEALTH_V1 = None


# ---------------------------------------------------------------- app / browser
@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pw = await async_playwright().start()
    app.state.ctx = await app.state.pw.chromium.launch_persistent_context(
        USER_DATA_DIR,
        headless=HEADLESS,
        user_agent=UA,
        locale="en-CA",
        timezone_id="America/Toronto",
        viewport={"width": 1366, "height": 900},
        args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    )
    app.state.lock = asyncio.Semaphore(3)
    yield
    try:
        await app.state.ctx.close()
    finally:
        await app.state.pw.stop()


app = FastAPI(lifespan=lifespan)


def auth(secret: Optional[str]):
    if WORKER_SECRET and secret != WORKER_SECRET:
        raise HTTPException(status_code=401, detail="bad secret")


@app.get("/health")
async def health():
    return {"ok": True, "headless": HEADLESS}


# ---------------------------------------------------------------- /render
class RenderIn(BaseModel):
    url: str
    wait_ms: int = 1200
    wait_selector: Optional[str] = None


@app.post("/render")
async def render(body: RenderIn, x_worker_secret: Optional[str] = Header(None)):
    auth(x_worker_secret)
    async with app.state.lock:
        page = await app.state.ctx.new_page()
        try:
            if _STEALTH_V2:
                await _STEALTH_V2.apply_stealth_async(page)
            elif _STEALTH_V1:
                await _STEALTH_V1(page)

            resp = await page.goto(body.url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT)
            status = resp.status if resp else 0

            # Cloudflare "Just a moment..." wait loop (max ~20s)
            for _ in range(20):
                html = await page.content()
                title = (await page.title()) or ""
                if "Just a moment" not in title and "cf-challenge" not in html and "challenge-platform" not in html:
                    break
                await page.wait_for_timeout(1000)

            if body.wait_selector:
                try:
                    await page.wait_for_selector(body.wait_selector, timeout=8000)
                except Exception:
                    pass
            await page.wait_for_timeout(body.wait_ms)

            html = await page.content()
            text = await page.evaluate("() => document.body ? document.body.innerText : ''")
            return {"ok": True, "status": status, "url": page.url, "html": html, "text": text}
        except Exception as e:
            return {"ok": False, "status": 0, "url": body.url, "error": str(e), "html": "", "text": ""}
        finally:
            await page.close()


# ---------------------------------------------------------------- helpers
async def fetch_text(url: str, wait_ms: int = 900) -> Dict[str, str]:
    """httpx first (fast), browser fallback when blocked/empty."""
    try:
        async with httpx.AsyncClient(timeout=20, follow_redirects=True,
                                     headers={"User-Agent": UA, "Accept-Language": "en-CA,en;q=0.9"}) as c:
            r = await c.get(url)
            if r.status_code < 400 and len(r.text) > 800 and "Just a moment" not in r.text:
                return {"html": r.text, "url": str(r.url)}
    except Exception:
        pass
    out = await render(RenderIn(url=url, wait_ms=wait_ms), x_worker_secret=WORKER_SECRET or None)
    return {"html": out.get("html", ""), "url": out.get("url", url)}


def clean_emails(raw: List[str]) -> List[str]:
    seen, out = set(), []
    for e in raw:
        e = e.strip().strip(".,;:)").lower()
        if any(b in e for b in BAD_EMAIL_HINT):
            continue
        if len(e) > 80 or e in seen:
            continue
        seen.add(e)
        out.append(e)
    return out


def norm_phone(m) -> str:
    return f"({m.group(1)}) {m.group(2)}-{m.group(3)}"


def mx_ok(domain: str) -> bool:
    try:
        import dns.resolver
        return bool(dns.resolver.resolve(domain, "MX", lifetime=5))
    except Exception:
        try:
            socket.gethostbyname(domain)
            return True
        except Exception:
            return False


async def search(engine_url: str, link_filter=None) -> List[str]:
    page = await fetch_text(engine_url)
    soup = BeautifulSoup(page["html"], "html.parser")
    links: List[str] = []
    for a in soup.select("a[href]"):
        href = a["href"]
        if href.startswith("//duckduckgo.com/l/?uddg="):
            from urllib.parse import parse_qs, unquote
            href = unquote(parse_qs(urlparse("https:" + href).query).get("uddg", [""])[0])
        if not href.startswith("http"):
            continue
        if link_filter and not link_filter(href):
            continue
        if href not in links:
            links.append(href)
    return links[:25]


# ---------------------------------------------------------------- /osint
class OsintIn(BaseModel):
    company: str
    neq: Optional[str] = None
    city: Optional[str] = None
    province: Optional[str] = "Quebec"
    country: Optional[str] = "Canada"
    domain: Optional[str] = None
    extra_sites: List[str] = []
    max_pages: int = 12


@app.post("/osint")
async def osint(body: OsintIn, x_worker_secret: Optional[str] = Header(None)):
    auth(x_worker_secret)

    log: List[str] = []
    emails: List[str] = []
    phones: List[str] = []
    people: List[Dict[str, str]] = []
    socials: Dict[str, str] = {}
    address: Optional[str] = None
    domain = body.domain
    q_base = f'"{body.company}" {body.city or ""} {body.province or ""} {body.country or ""}'.strip()

    # 1) find the official website
    if not domain:
        log.append("search: locating official website")
        urls = await search(f"https://duckduckgo.com/html/?q={quote_plus(q_base + ' site officiel OR official website')}",
                            lambda h: not any(s in h for s in ("duckduckgo", "google.", "bing.", "facebook.", "linkedin.")))
        for u in urls[:5]:
            host = urlparse(u).netloc.lower().replace("www.", "")
            if host and "." in host:
                domain = host
                log.append(f"website candidate: {domain}")
                break

    # 2) crawl the website (home + contact-ish pages)
    if domain:
        base = f"https://{domain}"
        pages = [base]
        home = await fetch_text(base)
        soup = BeautifulSoup(home["html"], "html.parser")
        for a in soup.select("a[href]"):
            t = (a.get_text() or "").lower() + " " + a["href"].lower()
            if any(k in t for k in ("contact", "about", "propos", "equipe", "team", "direction", "nous")):
                pages.append(urljoin(base, a["href"]))
        seen = []
        for p in pages:
            if p in seen or len(seen) >= body.max_pages:
                continue
            seen.append(p)
            r = await fetch_text(p)
            html = r["html"]
            txt = BeautifulSoup(html, "html.parser").get_text(" ", strip=True)
            emails += EMAIL_RE.findall(html)
            phones += [norm_phone(m) for m in PHONE_RE.finditer(txt)]
            for a in BeautifulSoup(html, "html.parser").select("a[href]"):
                h = a["href"]
                for net in ("linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com"):
                    if net in h and net not in socials:
                        socials[net] = h
            if not address:
                m = re.search(r"\d{1,5}[^,\n]{3,60},\s*[A-Za-zÀ-ÿ\-\s']{2,40},?\s*(QC|Qu[ée]bec|ON|Ontario)[^,\n]{0,20}[A-Z]\d[A-Z]\s?\d[A-Z]\d", txt)
                if m:
                    address = m.group(0)
            log.append(f"crawled {p} ({len(emails)} emails so far)")

    # 3) social / directory discovery
    for site, key in (("linkedin.com/company", "linkedin.com"),
                      ("facebook.com", "facebook.com"),
                      ("b2bhint.com", "b2bhint.com"),
                      ("opencorporates.com", "opencorporates.com")):
        try:
            found = await search(
                f"https://duckduckgo.com/html/?q={quote_plus(f'site:{site} ' + body.company + ' ' + (body.city or ''))}",
                lambda h, s=site.split('/')[0]: s in h)
            if found:
                socials.setdefault(key, found[0])
                log.append(f"{key}: {found[0]}")
        except Exception as e:
            log.append(f"{key} search failed: {e}")

    # 4) directory pages (facebook/b2bhint) rendered for emails/phones/address
    for key in ("facebook.com", "b2bhint.com", "opencorporates.com"):
        if key in socials:
            r = await fetch_text(socials[key], wait_ms=2000)
            txt = BeautifulSoup(r["html"], "html.parser").get_text(" ", strip=True)
            emails += EMAIL_RE.findall(txt)
            phones += [norm_phone(m) for m in PHONE_RE.finditer(txt)]

    # 5) user-provided target sites
    for site in body.extra_sites:
        try:
            hits = await search(f"https://duckduckgo.com/html/?q={quote_plus(f'site:{site} ' + body.company)}")
            for u in hits[:3]:
                r = await fetch_text(u, wait_ms=1200)
                txt = BeautifulSoup(r["html"], "html.parser").get_text(" ", strip=True)
                emails += EMAIL_RE.findall(txt)
                phones += [norm_phone(m) for m in PHONE_RE.finditer(txt)]
                log.append(f"extra site {site}: {u}")
        except Exception as e:
            log.append(f"extra site {site} failed: {e}")

    emails = clean_emails(emails)
    if domain:
        emails.sort(key=lambda e: 0 if e.endswith("@" + domain) else 1)

    phones = list(dict.fromkeys(phones))[:5]
    verified = {e: mx_ok(e.split("@")[-1]) for e in emails[:10]}

    return {
        "ok": True,
        "domain": domain,
        "emails": emails[:10],
        "email_mx": verified,
        "phones": phones,
        "people": people,
        "address": address,
        "socials": socials,
        "log": log,
    }

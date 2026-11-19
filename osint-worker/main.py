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
OSINT_TIMEOUT = max(30, min(300, int(os.environ.get("OSINT_TIMEOUT_SECONDS", "150"))))
SMTP_TIMEOUT = max(10, min(120, int(os.environ.get("SMTP_TIMEOUT_SECONDS", "30"))))
MAX_OSINT_BROWSER_FALLBACKS = max(0, min(6, int(os.environ.get("MAX_OSINT_BROWSER_FALLBACKS", "2"))))

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONE_RE = re.compile(r"(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})")
EXEC_TITLE_RE = re.compile(
    r"\b(Président|Présidente|Directeur Général|Directrice Générale|DG|PDG|Fondateur|Fondatrice|Propriétaire|CEO|President|Owner|Directeur|Directrice|VP|Vice-Président|Vice-Présidente|Partner|Associé|Associée|Managing Director|General Manager|Principal|Executive Director|Administrateur|Administratrice|Leader|Dentiste|Chirurgien|Chirurgienne|Docteur|Docteure|Dr|Médecin|Avocat|Avocate|Notaire|Comptable|Gestionnaire|Secrétaire|Trésorier|Trésorière)\b",
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
    "lightinthebox.com", "miniinthebox.com", "aliexpress.com", "alibaba.com",
    "temu.com", "shein.com", "wish.com", "dhgate.com", "myshopify.com", "shopify.com",
)
BAD_HOSTS = ("duckduckgo.com", "google.", "bing.com", "yahoo.", "mojeek.com", "search.brave.com")

# Directory / review portals — never accept these as a company's official domain.
# Instead, scrape them for outbound links that may point to the real company website.
DIRECTORY_DOMAINS = (
    "restaurantguru.com", "yelp.com", "yelp.ca", "tripadvisor.com", "tripadvisor.ca",
    "yellowpages.ca", "pagesjaunes.ca", "canada411.ca", "goldbook.ca", "411.ca",
    "ubereats.com", "doordash.com", "skipthedishes.com", "grubhub.com",
    "restomontreal.ca", "restoenligne.ca", "tastet.ca",
    "cylex-canada.ca", "ourbis.ca", "kompass.com", "manta.com",
    "b2bhint.com", "opencorporates.com", "societe.com", "zoominfo.com",
    "crunchbase.com", "glassdoor.com", "indeed.com", "dnb.com",
    "can1business.com", "opengovca.com", "quebeccompanies.com",
    "bbb.org", "trustpilot.com", "foursquare.com",
)

CANADA_RE = re.compile(
    r"\b(canada|canadian|qu[ée]bec|quebec|montr[ée]al|montreal|ottawa|toronto|vancouver|calgary|"
    r"edmonton|winnipeg|halifax|saskatoon|regina|new brunswick|nova scotia|ontario|alberta|"
    r"british columbia|manitoba|saskatchewan|pei|newfoundland|yukon|nunavut|northwest territories|"
    r"laval|gatineau|longueuil|sherbrooke|saguenay|l[ée]vis|trois-rivi[èe]res|terrebonne|saint-jean-sur-richelieu|"
    r"brossard|repentigny|saint-j[ée]r[ôo]me|drummondville|granby|saint-hyacinthe|beloeil|joliette|victoriaville|"
    r"rimouski|chibougamau|rouyn-noranda|val-d'or|salaberry-de-valleyfield|shawinigan|"
    r"514|438|450|579|418|581|367|819|873|"
    r"[A-Z]\d[A-Z][ -]?\d[A-Z]\d)\b",
    re.IGNORECASE,
)
FOREIGN_LOCATION_RE = re.compile(
    r"\b(france|paris|lyon|marseille|belgique|belgium|suisse|switzerland|united kingdom|"
    r"royaume-uni|australia|australie|united states|[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b",
    re.IGNORECASE,
)


def is_directory_host(host: str) -> bool:
    """Returns True when `host` is a known directory / review portal."""
    host = host.lower().replace("www.", "")
    return any(host == d or host.endswith("." + d) for d in DIRECTORY_DOMAINS)


def name_matches_host(company_name: str, trade_names: List[str], host: str) -> bool:
    """True when the company (or one of its trade names) plausibly matches the hostname."""
    host = host.lower().replace("www.", "")
    base = host.split(".")[0].replace("-", "").replace("_", "")
    if not base or len(base) < 3:
        return False
    flat = host.replace(".", "").replace("-", "")
    all_names = [company_name] + list(trade_names)
    for name in all_names:
        token = deaccent(LEGAL_SUFFIX_RE.sub(" ", name).strip()).replace(" ", "")
        if not token or len(token) < 3:
            continue
        if flat.startswith(token[:8]) or token.startswith(base[:8]):
            return True
        if base in token or token in flat:
            return True
        # Partial head match (at least 5 chars)
        head = token[:max(5, min(8, len(token)))]
        if base.startswith(head) or head.startswith(base[:6]):
            return True
    return False


def extract_outbound_company_links(html: str, company_name: str, trade_names: List[str]) -> List[str]:
    """From a directory listing page, extract outbound <a> links whose host
    resembles the company name — these are likely the official website."""
    if not html:
        return []
    soup = BeautifulSoup(html, "html.parser")
    outbound: List[str] = []
    for a in soup.select("a[href]"):
        href = a.get("href", "")
        if not href.startswith("http"):
            continue
        host = urlparse(href).netloc.lower().replace("www.", "")
        if not host or "." not in host:
            continue
        # Skip links pointing back to the directory itself or social/search
        if is_directory_host(host) or any(b in host for b in BAD_HOSTS):
            continue
        if any(s in host for s in ("facebook.com", "linkedin.com", "instagram.com", "twitter.com", "x.com", "youtube.com")):
            continue
        if name_matches_host(company_name, trade_names, host):
            if href not in outbound:
                outbound.append(href)
    return outbound[:5]

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
            html = unmask_cloudflare_emails(await page.content())
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


async def _search_google_maps_impl(query: str) -> Dict[str, Any]:
    """Fast, lightweight Google Maps place reconnaissance on Chromium."""
    async with app.state.lock:
        context = None
        page = None
        try:
            await ensure_browser(app)
            context = await app.state.browser.new_context(
                user_agent=UA,
                locale="fr-CA",
                timezone_id="America/Toronto",
                viewport={"width": 1280, "height": 800},
                extra_http_headers={"Accept-Language": "fr-CA,fr;q=0.9,en-CA;q=0.8"},
            )
            page = await context.new_page()
            page.set_default_timeout(14000)

            async def _block_media(route):
                if route.request.resource_type in ("image", "media", "font"):
                    await route.abort()
                else:
                    await route.continue_()

            await page.route("**/*", _block_media)
            url = f"https://www.google.com/maps/search/{quote_plus(query)}/"
            await page.goto(url, wait_until="domcontentloaded", timeout=14000)
            await page.wait_for_timeout(2000)

            res: Dict[str, Any] = {"address": None, "phone": None, "website": None, "title": None, "html": ""}

            title = (await page.title()) or ""
            res["title"] = title.replace(" - Google Maps", "").strip()

            # Address element
            addr_el = page.locator("button[data-item-id*='address'], [aria-label*='Address'], [aria-label*='Adresse']").first
            if await addr_el.count() > 0:
                txt = await addr_el.text_content() or await addr_el.get_attribute("aria-label")
                if txt:
                    res["address"] = txt.strip().replace("", "").strip()

            # Phone element
            phone_el = page.locator("button[data-item-id*='phone'], [aria-label*='Phone'], [aria-label*='Téléphone']").first
            if await phone_el.count() > 0:
                txt = await phone_el.text_content() or await phone_el.get_attribute("aria-label")
                if txt:
                    res["phone"] = txt.strip().replace("", "").strip()

            # Website element
            web_el = page.locator("a[data-item-id*='authority'], [aria-label*='Website'], [aria-label*='Site Web']").first
            if await web_el.count() > 0:
                txt = await web_el.get_attribute("href") or await web_el.text_content()
                if txt:
                    res["website"] = txt.strip()

            res["html"] = await page.content()
            return res
        except Exception as e:
            return {"address": None, "phone": None, "website": None, "title": None, "html": "", "error": str(e)}
        finally:
            if page:
                with suppress(Exception):
                    await page.unroute_all(behavior="wait")
                with suppress(Exception):
                    await asyncio.wait_for(page.close(), timeout=5)
            if context:
                with suppress(Exception):
                    await asyncio.wait_for(context.close(), timeout=5)


def decode_cloudflare_email(cf_hex: str) -> str:
    try:
        k = int(cf_hex[:2], 16)
        return "".join([chr(int(cf_hex[i:i+2], 16) ^ k) for i in range(2, len(cf_hex), 2)])
    except Exception:
        return ""


def unmask_cloudflare_emails(html: str) -> str:
    if not html or ("email-protection" not in html and "data-cfemail" not in html):
        return html
    html = re.sub(
        r'href=["\'](?:/cdn-cgi/l/email-protection#|#)([a-fA-F0-9]{4,})["\']',
        lambda m: f'href="mailto:{decode_cloudflare_email(m.group(1))}"' if decode_cloudflare_email(m.group(1)) else m.group(0),
        html,
    )
    html = re.sub(
        r'data-cfemail=["\']([a-fA-F0-9]{4,})["\'][^>]*>(?:\[email&#160;protected\]|\[email protected\])?<',
        lambda m: f'>{decode_cloudflare_email(m.group(1))}<' if decode_cloudflare_email(m.group(1)) else m.group(0),
        html,
    )
    return html


# ---------------------------------------------------------------- Advanced OSINT & Clean Markdown Modules
def clean_html_to_markdown(raw_html: str) -> str:
    """Strips noisy layout tags, scripts, and attributes, returning clean structured Markdown."""
    if not raw_html:
        return ""
    try:
        raw_html = unmask_cloudflare_emails(raw_html)
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
                return {"html": unmask_cloudflare_emails(r.text), "url": str(r.url)}
    except Exception:
        pass
    if not allow_browser:
        return {"html": "", "url": url}
    out = await render(RenderIn(url=url, wait_ms=wait_ms), x_worker_secret=WORKER_SECRET or None)
    return {"html": unmask_cloudflare_emails(out.get("html", "")), "url": out.get("url", url)}


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


NON_NAME_WORDS = {
    "united", "states", "america", "americas", "china", "canada", "quebec", "montreal", "france",
    "paris", "europe", "asia", "pacific", "kingdom", "africa", "japan", "australia", "germany",
    "ireland", "scotland", "netherlands", "hong", "kong", "chancellor", "president", "director",
    "partner", "lead", "officer", "manager", "operations", "senior", "global", "regional", "country",
    "national", "appointed", "search", "about", "contact", "read", "view", "show", "refine", "explore",
    "useful", "terms", "policy", "privacy", "cookies", "legal", "copyright", "rights", "reserved",
    "open", "roles", "case", "studies", "insights", "services", "expertise", "people", "team",
    "executive", "board", "chair", "trust", "group", "holdings", "associates", "consultants",
    "as", "pro", "or", "for", "and", "the", "our", "votre", "notre", "equipe", "équipe",
    "clinique", "dentaire", "centre", "cabinet", "bureau", "conseil", "administration", "gouvernance",
    "direction", "membres", "personnel", "staff", "denturologiste", "hygiéniste", "hygieniste",
    "assistante", "assistant", "réceptionniste", "receptionniste", "infirmier", "infirmière",
    "technicien", "technicienne",
}


def clean_person_name(raw: str) -> str:
    name = re.sub(r"^#+\s*", "", raw).strip()
    name = re.sub(r"^\[([^\]]+)\].*$", r"\1", name).strip()
    name = re.sub(r"^(?:Dr\.?|Mme\.?|Mr\.?|Ms\.?|Prof\.?)\s*", "", name, flags=re.I).strip()
    name = re.sub(
        r"\s*(?:vice|président(?:e)?|direct(?:eur|rice)|president|ceo|owner|fondat(?:eur|rice)|associé(?:e)?|gérant(?:e)?|chief|partner|director|dentiste|chirurgien(?:ne)?|docteur(?:e)?|dr|médecin|avocat(?:e)?|notaire|comptable|gestionnaire|administrat(?:eur|rice)|denturologiste|hygi[ée]niste|assistante?|r[ée]ceptionniste)$",
        "",
        name,
        flags=re.IGNORECASE,
    ).strip()
    return name


def is_valid_person_name(name: str) -> bool:
    if not name or len(name) < 3 or len(name) > 40:
        return False
    clean = clean_person_name(name)
    parts = clean.split()
    if len(parts) < 2 or len(parts) > 4:
        return False
    if any(p.lower() in NON_NAME_WORDS for p in parts):
        return False
    for p in parts:
        if not re.match(r"^[A-ZÀ-Ý][a-zà-ÿ'\-]+$", p):
            return False
    return True


def extract_people_from_dom(html: str) -> List[Dict[str, Any]]:
    if not html:
        return []
    try:
        soup = BeautifulSoup(html, "html.parser")
        results = []
        seen = set()

        # 1. Specialized Executive, Leadership & Staff Card Containers
        selectors = [
            "[data-ux='ContentCard']", "[data-ux='Card']",
            ".people__item", ".team__item", ".team-member", ".team-card", ".person-card",
            ".profile-card", "[class*='people__item']", "[class*='team-member']",
            "[class*='person__card']", "[class*='member-card']", "[class*='staff-member']",
            "[class*='staff-card']", "[class*='doctor-card']", "[class*='dentist-card']",
            "[class*='leadership-card']", "[class*='bio-card']", "[class*='board-member']"
        ]
        card_nodes = soup.select(", ".join(selectors))
        for card in card_nodes:
            # First heading in the card is usually the person's name
            heading = card.find(["h1", "h2", "h3", "h4", "h5", "h6", "strong"])
            cand_raw = heading.get_text(strip=True) if heading else ""
            if not cand_raw:
                lines = [l.strip() for l in card.get_text("\n", strip=True).split("\n") if l.strip()]
                cand_raw = lines[0] if lines else ""

            cand_name = clean_person_name(cand_raw)
            if not is_valid_person_name(cand_name):
                continue
            norm = cand_name.lower()
            if norm in seen:
                continue

            # Look for an executive/professional title inside the card
            card_text = card.get_text(" ", strip=True)
            m_t = EXEC_TITLE_RE.search(card_text)
            title = m_t.group(0).strip() if m_t else "Executive"

            email = None
            mail_a = card.select_one('a[href^="mailto:"]')
            if mail_a:
                raw_href = mail_a.get("href", "")
                cleaned = raw_href.replace("mailto:", "").split("?")[0].strip().lower()
                if "@" in cleaned and "." in cleaned:
                    email = cleaned

            phone = None
            tel_a = card.select_one('a[href^="tel:"]')
            if tel_a:
                phone = tel_a.get("href", "").replace("tel:", "").strip()

            seen.add(norm)
            results.append({
                "name": cand_name,
                "title": title,
                "email": email,
                "phone": phone
            })

        # 2. Dedicated Staff & Doctor Profile Links (e.g. /staff/dr-anthony-mikhayel)
        staff_links = soup.find_all("a", href=re.compile(r"/(?:staff|equipe|team|dr-|people|leadership)/", re.I))
        for a in staff_links:
            link_text = a.get_text(" ", strip=True)
            clean_l = clean_person_name(link_text)
            if not is_valid_person_name(clean_l):
                continue
            norm = clean_l.lower()
            if norm in seen:
                continue

            m_t = EXEC_TITLE_RE.search(link_text)
            title = m_t.group(0).strip() if m_t else "Executive"
            seen.add(norm)
            results.append({
                "name": clean_l,
                "title": title,
                "email": None,
                "phone": None
            })

        # 3. Direct Mailto Containers: Check parent container for person names
        for mail_a in soup.select('a[href^="mailto:"]'):
            raw_href = mail_a.get("href", "")
            cleaned_email = raw_href.replace("mailto:", "").split("?")[0].strip().lower()
            if "@" not in cleaned_email or "." not in cleaned_email:
                continue

            # Look up to 3 parent elements for a person name heading
            curr = mail_a.parent
            for _ in range(3):
                if not curr:
                    break
                heading = curr.find(["h1", "h2", "h3", "h4", "h5", "h6", "strong"])
                if heading:
                    h_clean = clean_person_name(heading.get_text(strip=True))
                    if is_valid_person_name(h_clean):
                        h_norm = h_clean.lower()
                        # If already in results without email, update email
                        existing = next((r for r in results if r["name"].lower() == h_norm), None)
                        if existing and not existing.get("email"):
                            existing["email"] = cleaned_email
                        elif not existing and h_norm not in seen and len(results) < 30:
                            m_t = EXEC_TITLE_RE.search(curr.get_text(" ", strip=True))
                            seen.add(h_norm)
                            results.append({
                                "name": h_clean,
                                "title": m_t.group(0).strip() if m_t else "Executive",
                                "email": cleaned_email,
                                "phone": None
                            })
                        break
                curr = curr.parent

        return results
    except Exception:
        return []


def extract_people_from_markdown(text: str) -> List[Dict[str, str]]:
    if not text:
        return []
    results = []
    seen = set()
    name_pat = r"([A-ZÀ-Ý][a-zà-ÿ'\-]+(?:[ \t]+[A-ZÀ-Ý][a-zà-ÿ'\-]+){1,2})"
    title_words = (
        r"(?:Président(?:e)?(?:[- ]Directeur[- ]Général)?|Vice[- ]Président(?:e)?|"
        r"Direct(?:eur|rice)(?:\s+Général(?:e)?|\s+d'[ée]tudes|\s+des\s+[ée]tudes)?|"
        r"Propriétaire|Fondat(?:eur|rice)|Associé(?:e)?|Gérant(?:e)?|Administrat(?:eur|rice)|"
        r"Recteur|Rectrice|Doyen(?:ne)?|Principal(?:e)?|Provost|Chancellor|Coordonnat(?:eur|rice)|"
        r"Secrétaire(?:\s+Général(?:e)?|[- /]Tr?[ée]sori[èe]re|[- /]Tr?[ée]sorier)?|Tr?[ée]sorier(?:i[èe]re)?|DG|PDG|"
        r"Chief Executive Officer|CEO|CFO|COO|CTO|CMO|CRO|President|Owner|Founder|"
        r"General Manager|Managing Director|Partner|Executive Director|Director|VP|Vice[- ]President|"
        r"Dentiste|Chirurgien(?:ne)?(?:\s+Dentiste)?|Docteur(?:e)?|Dr|Médecin|Avocat(?:e)?|Notaire|Comptable|Gestionnaire)"
    )

    # 1. Inline pattern: "Name, Title" or "Title: Name"
    pats = [
        re.compile(rf"{name_pat}[ \t]*[,–—\-][ \t]*((?i:{title_words}))"),
        re.compile(rf"((?i:{title_words}))[ \t]*[:,–—\-][ \t]*{name_pat}"),
    ]
    for idx, pat in enumerate(pats):
        for m in pat.finditer(text):
            raw_name = m.group(1 if idx == 0 else 2).strip()
            raw_title = m.group(2 if idx == 0 else 1).strip()
            clean_name = clean_person_name(raw_name)
            if not is_valid_person_name(clean_name):
                continue
            clean_norm = clean_name.lower()
            if clean_norm not in seen and len(results) < 30:
                seen.add(clean_norm)
                results.append({"name": clean_name, "title": raw_title})

    # 2. Multi-line pattern: Name on line N, Title on line N+1..N+5, OR Title on line N, Name on line N+1..N+4
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    title_sub_re = re.compile(rf"\b({title_words})\b", re.I)

    for i, line in enumerate(lines):
        raw_name = re.sub(r"^#+\s*", "", line).strip()
        raw_name = re.sub(r"^\[([^\]]+)\].*$", r"\1", raw_name).strip()
        clean_name = clean_person_name(raw_name)

        # Case A: Name on line i, Title on line i+1..i+5
        if is_valid_person_name(clean_name):
            clean_norm = clean_name.lower()
            if clean_norm not in seen:
                matched_title = None
                matched_email = None
                for offset in range(1, 6):
                    if i + offset >= len(lines):
                        break
                    cand_line = lines[i + offset]
                    m_t = title_sub_re.search(cand_line)
                    if m_t and not matched_title:
                        matched_title = m_t.group(0).strip()
                    m_e = re.search(r"(?:mailto:)?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})", cand_line)
                    if m_e and not matched_email:
                        matched_email = m_e.group(1).lower()
                    cand_clean = clean_person_name(re.sub(r"^#+\s*", "", cand_line).strip())
                    if is_valid_person_name(cand_clean) and cand_clean.lower() != clean_norm:
                        break

                # Also check if title was directly in the line itself (e.g. [Dr Anthony MikhayelDentiste](/staff/...))
                if not matched_title:
                    m_same = title_sub_re.search(line)
                    if m_same:
                        matched_title = m_same.group(0).strip()

                if matched_title and len(results) < 30:
                    seen.add(clean_norm)
                    item = {"name": clean_name, "title": matched_title}
                    if matched_email:
                        item["email"] = matched_email
                    results.append(item)

        # Case B: Title on line i, Name on line i+1..i+4 (e.g. "Président \n Christian Rock")
        title_only_match = re.match(rf"^\s*({title_words})\s*$", line, re.I)
        if title_only_match:
            found_title = title_only_match.group(1).strip()
            for offset in range(1, 5):
                if i + offset >= len(lines):
                    break
                next_line = lines[i + offset]
                cand_raw = re.sub(r"^#+\s*", "", next_line).strip()
                cand_raw = re.sub(r"^\[([^\]]+)\].*$", r"\1", cand_raw).strip()
                cand_clean = clean_person_name(cand_raw)
                if is_valid_person_name(cand_clean):
                    clean_norm = cand_clean.lower()
                    if clean_norm not in seen and len(results) < 30:
                        seen.add(clean_norm)
                        matched_email = None
                        for sub_offset in range(1, 4):
                            if i + offset + sub_offset >= len(lines):
                                break
                            sub_line = lines[i + offset + sub_offset]
                            m_e = re.search(r"(?:mailto:)?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})", sub_line)
                            if m_e:
                                matched_email = m_e.group(1).lower()
                                break
                        item = {"name": cand_clean, "title": found_title}
                        if matched_email:
                            item["email"] = matched_email
                        results.append(item)
                    break

    return results


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
        f"{first[0]}.{last}@{domain}",
        f"{first[0]}{last}@{domain}",
        f"{first}@{domain}",
        f"{last}@{domain}",
        f"{first}{last}@{domain}",
        f"{first}_{last}@{domain}",
    ]


def _extract_search_links(html: str, link_filter=None) -> List[str]:
    if not html:
        return []
    soup = BeautifulSoup(html, "html.parser")
    links: List[str] = []
    for a in soup.select("a[href]"):
        href = a["href"]
        if "//duckduckgo.com/l/?uddg=" in href:
            full = "https:" + href if href.startswith("//") else href
            href = unquote(parse_qs(urlparse(full).query).get("uddg", [""])[0])
        elif "/r.search.yahoo.com/" in href or "/RU=" in href:
            m = re.search(r"/RU=([^/]+)/", href)
            if m:
                href = unquote(m.group(1))
        if not href.startswith("http"):
            continue
        if any(h in href for h in BAD_HOSTS):
            continue
        if link_filter and not link_filter(href):
            continue
        if href not in links:
            links.append(href)
    return links[:25]


async def search(engine_url: str, link_filter=None, allow_browser: bool = True) -> List[str]:
    # Extract search query from engine_url if present
    parsed = urlparse(engine_url)
    qs = parse_qs(parsed.query)
    q = qs.get("q", [""])[0] or qs.get("p", [""])[0]

    # 1. First try DuckDuckGo Lite via POST (fastest, unblocked 200ms)
    if q:
        try:
            async with httpx.AsyncClient(
                timeout=8, follow_redirects=True,
                headers={"User-Agent": UA, "Accept-Language": "fr-CA,fr;q=0.9,en-CA;q=0.8"}
            ) as client:
                r = await client.post("https://lite.duckduckgo.com/lite/", data={"q": q})
                if r.status_code == 200:
                    links = _extract_search_links(r.text, link_filter)
                    if links:
                        return links[:25]
        except Exception:
            pass

    # 2. Direct HTTP GET
    page = await fetch_text(engine_url, allow_browser=False)
    links = _extract_search_links(page.get("html", ""), link_filter)

    # 3. Browser fallback with Playwright
    if not links and allow_browser:
        page = await fetch_text(engine_url, wait_ms=1200, allow_browser=True)
        links = _extract_search_links(page.get("html", ""), link_filter)
    return links[:25]


def activity_matches(page_text: str, activity: Optional[str]) -> bool:
    """Returns False when page content strongly contradicts the company's registered economic activity."""
    if not activity or len(activity) < 4:
        return True
    stopwords = {"services", "fourniture", "commerce", "autre", "autres", "vente", "activite", "activités", "generale", "générale", "d'autres", "detail", "détail"}
    act_tokens = [
        deaccent(t) for t in re.split(r"[^a-zA-ZÀ-ÿ]+", activity.lower())
        if len(t) >= 4 and deaccent(t) not in stopwords
    ]
    if not act_tokens:
        return True
    flat_text = deaccent(page_text.lower())
    return any(tok in flat_text for tok in act_tokens)


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
    address: Optional[str] = None
    postal_code: Optional[str] = None
    extra_sites: List[str] = []
    sites: List[str] = []
    max_pages: int = 35
    # REQ economic activity description (e.g. "Fourniture de services informatiques")
    activity: Optional[str] = None
    # Active trade names / DBA from REQ (e.g. ["NETTOYEUR INDUSTRIEL PRO/MAX"])
    trade_names: List[str] = []


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
    address: Optional[str] = body.address
    domain = body.domain
    input_activity = (body.activity or "").strip()
    input_trade_names = [t.strip() for t in (body.trade_names or []) if t.strip()]
    browser_budget = MAX_OSINT_BROWSER_FALLBACKS
    # Track raw execution data for frontend "pre-record activity" display
    raw_execution_sources: List[Dict[str, Any]] = []

    async def osint_fetch(url: str, wait_ms: int = 900) -> Dict[str, str]:
        nonlocal browser_budget
        direct = await fetch_text(url, wait_ms=wait_ms, allow_browser=False)
        if direct["html"] or browser_budget <= 0:
            return direct
        browser_budget -= 1
        return await fetch_text(url, wait_ms=wait_ms, allow_browser=True)

    def add_raw_source(url: str, html: str, extraction_points: List[str], selector: str = ""):
        """Log raw HTML/JS source info for data extraction provenance."""
        source_info = {
            "url": url,
            "selector": selector or "general",
            "extraction_points": extraction_points[:5],  # Limit to top 5 points
            "html_preview": html[:2000] if html else "",
        }
        raw_execution_sources.append(source_info)
        log.append(f"[RAW] Source: {url} - Extraction points: {', '.join(extraction_points[:3])}")

    clean_name = LEGAL_SUFFIX_RE.sub("", company_name).strip()
    # Use first trade name as search alias if available (numbered companies)
    search_name = input_trade_names[0] if input_trade_names else clean_name
    city_str = body.city or ""
    q_base = f'"{search_name}" {city_str} {body.province or ""} {body.country or ""}'.strip()

    # 1a. Google Maps Reconnaissance Pass (Place, Verified Address, Business Phone, Official Website)
    maps_query = f"{search_name} {city_str} {body.province or 'Quebec'}".strip()
    try:
        maps_result = await pw_thread.run_coro(_search_google_maps_impl(maps_query))
        if maps_result:
            maps_addr = maps_result.get("address")
            maps_phone = maps_result.get("phone")
            maps_web = maps_result.get("website")

            if maps_addr and not address:
                address = maps_addr
                log.append(f"Google Maps: Verified civic address -> {address}")

            if maps_phone:
                parsed_phone = norm_phone(PHONE_RE.search(maps_phone)) if PHONE_RE.search(maps_phone) else maps_phone
                if parsed_phone and parsed_phone not in phones:
                    phones.insert(0, parsed_phone)
                    log.append(f"Google Maps: Verified local phone -> {parsed_phone}")

            if maps_web and not domain:
                maps_host = urlparse(maps_web).netloc.lower().replace("www.", "")
                if maps_host and not is_directory_host(maps_host) and name_matches_host(company_name, input_trade_names, maps_host):
                    domain = maps_host
                    log.append(f"Google Maps: Discovered official domain -> {domain}")

            if maps_result.get("html"):
                add_raw_source(
                    f"https://www.google.com/maps/search/{quote_plus(maps_query)}/",
                    maps_result["html"][:2000],
                    ["google_maps_place", "verified_address", "verified_phone"] if maps_addr or maps_phone else ["google_maps_query"],
                    "google_maps"
                )
                socials["maps.google.com"] = f"https://www.google.com/maps/search/{quote_plus(maps_query)}/"
    except Exception as e:
        log.append(f"Google Maps recon pass: {e}")

    # 1. Official Domain Discovery (with directory-trap protection)
    if not domain:
        log.append(f"Searching official domain for '{search_name}'")
        search_candidates = [
            f"https://duckduckgo.com/html/?q={quote_plus(q_base + ' site officiel OR official website')}",
            f"https://ca.search.yahoo.com/search?p={quote_plus(search_name + ' ' + city_str + ' Quebec contact courriel')}",
            f"https://ca.search.yahoo.com/search?p={quote_plus(search_name + ' site officiel')}",
        ]
        # Also search by trade names if the main name is a numbered corp
        if input_trade_names and input_trade_names[0] != clean_name:
            search_candidates.insert(0,
                f"https://duckduckgo.com/html/?q={quote_plus(input_trade_names[0] + ' ' + city_str + ' Quebec site officiel')}"
            )
        urls = []
        for s_url in search_candidates:
            urls = await search(
                s_url,
                lambda h: not any(s in h for s in (*BAD_HOSTS, "facebook.com", "linkedin.com", "yellowpages.ca")),
                allow_browser=True,
            )
            if urls:
                break
        for u in urls[:6]:
            host = urlparse(u).netloc.lower().replace("www.", "")
            candidate_page = await osint_fetch(u, wait_ms=500)
            candidate_html = unmask_cloudflare_emails(candidate_page["html"])
            candidate_text = clean_html_to_markdown(candidate_html)

            # Check economic activity match if REQ activity was provided
            if input_activity and not activity_matches(candidate_text, input_activity):
                log.append(f"Domain candidate {host} skipped: does not match economic activity '{input_activity}'")
                continue

            # --- DIRECTORY TRAP: If this is a directory portal, do NOT adopt its
            # domain. Instead, extract outbound links that may point to the real
            # company website and mine the directory page for contact data. ---
            if is_directory_host(host):
                log.append(f"Directory detected: {host} — extracting outbound company links")
                # Mine directory listing for emails/phones/people
                emails += clean_emails(EMAIL_RE.findall(candidate_html))
                phones += [norm_phone(m) for m in PHONE_RE.finditer(candidate_text)]
                people += extract_people_from_markdown(candidate_text)
                add_raw_source(u, candidate_html,
                    ["directory_listing", "outbound_links", "contact_extraction"],
                    f"directory:{host}")
                # Follow outbound links to the real company site
                outbound = extract_outbound_company_links(
                    candidate_html, company_name, input_trade_names)
                for ob_url in outbound:
                    ob_host = urlparse(ob_url).netloc.lower().replace("www.", "")
                    if is_directory_host(ob_host):
                        continue
                    ob_page = await osint_fetch(ob_url, wait_ms=600)
                    ob_text = clean_html_to_markdown(ob_page["html"])
                    # Validate: must be Canadian, not a foreign lookalike
                    if FOREIGN_LOCATION_RE.search(ob_text) and not CANADA_RE.search(ob_text):
                        log.append(f"Rejected foreign domain from directory link: {ob_host}")
                        continue
                    domain = ob_host
                    log.append(f"Domain extracted from directory outbound link: {domain}")
                    add_raw_source(ob_url, ob_page["html"],
                        ["domain_verification", "directory_outbound"],
                        "directory extracted domain")
                    break
                continue  # Don't adopt the directory host as domain

            # --- FOREIGN LOOKALIKE CHECK: Reject domains whose pages show
            # foreign evidence (France, Belgium, etc.) without Canadian markers ---
            if host and "." in host and trusted_company_page(candidate_text, u, company_name, body.neq, None):
                # Additional foreign-evidence check on the domain's own page
                if FOREIGN_LOCATION_RE.search(candidate_text) and not CANADA_RE.search(candidate_text):
                    log.append(f"Rejected foreign lookalike domain: {host} (foreign location markers, no Canadian evidence)")
                    continue
                # Also reject if the host doesn't plausibly match the company name
                if not name_matches_host(company_name, input_trade_names, host):
                    log.append(f"Rejected unrelated domain: {host} (hostname does not match company)")
                    continue
                domain = host
                log.append(f"Validated Canadian domain: {domain}")
                # Log raw HTML source for domain page
                add_raw_source(
                    u, candidate_html,
                    ["domain_verification", "company_mention"],
                    "domain discovery page"
                )
                break

    # 1b. Canadian Business Registry Lookup (Numbered entities & SMBs)
    is_numbered = bool(re.search(r"\b\d{4}[ -]?\d{4}\b|\b\d{6,8}\b", clean_name))
    if not domain or is_numbered:
        if is_numbered:
            log.append(f"Numbered corporation detected: querying Canadian business registry records for '{clean_name}'")
        reg_queries = [
            f"https://ca.search.yahoo.com/search?p={quote_plus(clean_name + ' Quebec registre entreprises OR can1business OR opengovca')}",
            f"https://duckduckgo.com/html/?q={quote_plus(clean_name + ' Quebec registre entreprises')}",
        ]
        for rq in reg_queries:
            r_urls = await search(
                rq,
                lambda h: any(k in h for k in ("can1business.com", "opengovca.com", "b2bhint.com", "quebecentreprises.com", "companies-canada.ca", "registre")),
                allow_browser=True,
            )
            for ru in r_urls[:3]:
                cand = await osint_fetch(ru, wait_ms=600)
                cand_html = unmask_cloudflare_emails(cand["html"])
                cand_text = clean_html_to_markdown(cand_html)
                if cand_text and (clean_name.lower() in cand_text.lower() or (body.neq and body.neq in cand_text)):
                    add_raw_source(ru, cand_html, ["registry_record", "trade_name_dba", "administrators"], "registry mirror")
                    emails += clean_emails(EMAIL_RE.findall(cand_html))
                    phones += [norm_phone(m) for m in PHONE_RE.finditer(cand_text)]
                    people += extract_people_from_markdown(cand_text)
                    if not address:
                        addr_m = re.search(r"\b\d+[\w\s,.-]+(?:Québec|Quebec|Montréal|Montreal|Laval|QC)[\w\s,.-]+[A-Z]\d[A-Z]\s*\d[A-Z]\d\b", cand_text)
                        if addr_m:
                            address = addr_m.group(0).strip()
                    log.append(f"Registry match: {urlparse(ru).netloc}")
                    break

    # 1c. Address-based fallback search (if domain not found and address provided)
    if not domain and (body.address or address):
        search_addr = body.address or address
        log.append(f"Searching by address: '{search_addr}'")
        addr_q = f'"{search_addr}" {city_str} Quebec contact courriel'
        addr_urls = await search(
            f"https://ca.search.yahoo.com/search?p={quote_plus(addr_q)}",
            lambda h: not any(s in h for s in (*BAD_HOSTS, "facebook.com", "linkedin.com")),
            allow_browser=True,
        )
        for au in addr_urls[:4]:
            cand = await osint_fetch(au, wait_ms=600)
            cand_html = unmask_cloudflare_emails(cand["html"])
            cand_text = clean_html_to_markdown(cand_html)
            host = urlparse(au).netloc.lower().replace("www.", "")
            if host and "." in host and not any(b in host for b in BAD_HOSTS) and not is_directory_host(host):
                add_raw_source(au, cand_html, ["address_fallback_match", "contact_info"], "address search match")
                emails += clean_emails(EMAIL_RE.findall(cand_html))
                phones += [norm_phone(m) for m in PHONE_RE.finditer(cand_text)]
                people += extract_people_from_markdown(cand_text)
                if not domain and trusted_company_page(cand_text, au, company_name, body.neq, None):
                    domain = host
                    log.append(f"Domain discovered via address search: {domain}")
                    break

    # 1d. Final foreign-lookalike guard: if we chose a domain, verify its homepage
    # is not from a foreign country with the same company name.
    if domain and not is_directory_host(domain):
        try:
            verify_page = await osint_fetch(f"https://{domain}", wait_ms=600)
            verify_text = clean_html_to_markdown(verify_page["html"])
            if FOREIGN_LOCATION_RE.search(verify_text) and not CANADA_RE.search(verify_text):
                log.append(f"Domain {domain} rejected at final foreign-check (page shows foreign location, no Canadian evidence)")
                domain = None
        except Exception:
            pass

    # 2. SpiderFoot & theHarvester Recon Pass
    if domain:
        sf_info = await spiderfoot_recon_domain(domain)
        if sf_info["mail_provider"] != "Unknown":
            log.append(f"SpiderFoot: Identified infrastructure -> {sf_info['mail_provider']}")

        harvester_emails, subdomains = await harvester_passive_discovery(domain, clean_name)
        if harvester_emails:
            emails += harvester_emails
            log.append(f"theHarvester: Found {len(harvester_emails)} passive email targets")
            # Log harvest source
            add_raw_source(
                f"crt.sh domain search: {domain}",
                str(harvester_emails[:500]),
                ["crt_sh_certificate_emails", "duckduckgo_dork_emails"],
            )
        if subdomains:
            log.append(f"theHarvester: Mapped subdomains -> {', '.join(subdomains[:4])}")

    # 3. Crawl Target Site Sub-Pages (Render & Clean Markdown)
    if domain:
        base = f"https://{domain}"

        # Priority keyword hints for leadership, executive, governance, medical, contact & team pages
        PRIORITY_PATH_HINTS = (
            "contact", "joindre", "coordonnees", "coordonnées", "a-propos", "apropos", "propos",
            "about", "equipe", "équipe", "team", "direction", "notre-entreprise", "staff",
            "leadership", "management", "people", "ppl", "nos-gens", "gens", "board",
            "administrateurs", "conseil", "administration", "gouvernance", "directors",
            "executives", "partners", "associates", "dentiste", "docteur", "chirurgien",
            "avocat", "notaire", "medecin", "médecin", "gestion", "membres", "dr-"
        )

        def is_priority_link(text_and_url: str) -> bool:
            return any(k in text_and_url.lower() for k in PRIORITY_PATH_HINTS)

        # 1. Fetch & analyze the homepage first
        home = await osint_fetch(base)
        home_html = unmask_cloudflare_emails(home.get("html", ""))
        add_raw_source(
            base, home_html,
            ["homepage_venue_links", "contact_page_links", "href_attributes"],
            "site discovery"
        )

        # Extract all internal links from the homepage navigation, header, menus, and footer
        soup_home = BeautifulSoup(home_html, "html.parser")
        tier1_pages: List[str] = []
        tier2_pages: List[str] = []

        for a in soup_home.select("a[href]"):
            raw_href = a.get("href", "").strip()
            if not raw_href or raw_href.startswith(("#", "javascript:", "mailto:", "tel:")):
                continue
            full_url = urljoin(base, raw_href)
            parsed = urlparse(full_url)
            if parsed.netloc.lower().replace("www.", "") == domain:
                combo = (a.get_text() or "").lower() + " " + raw_href.lower()
                if is_priority_link(combo):
                    if full_url not in tier1_pages:
                        tier1_pages.append(full_url)
                else:
                    if full_url not in tier2_pages:
                        tier2_pages.append(full_url)

        # Seed standard speculative paths for leadership, board, governance, medical, executive & contact pages
        SPECULATIVE_SUBPATHS = [
            "/conseil-dadministration", "/conseil-d-administration", "/conseil-administration", "/conseil",
            "/equipe", "/notre-equipe", "/direction", "/people", "/team", "/our-team", "/our-people",
            "/leadership", "/board", "/directors", "/executives", "/staff", "/administrateurs",
            "/gouvernance", "/gestion", "/membres", "/dentistes", "/dentiste", "/notre-equipe-dentaire",
            "/docteurs", "/docteur", "/practitioners", "/a-propos", "/contact", "/contactez-nous", "/nous-joindre"
        ]
        has_leadership_page = any(
            any(k in p.lower() for k in ("equipe", "direction", "conseil", "people", "team", "leadership", "board", "executives", "staff", "dentiste", "docteur", "admin"))
            for p in tier1_pages
        )
        if len(tier1_pages) < 4 or not has_leadership_page:
            for sub in SPECULATIVE_SUBPATHS:
                spec_url = urljoin(base, sub)
                if spec_url not in tier1_pages:
                    tier1_pages.append(spec_url)

        crawl_queue: List[str] = [base] + tier1_pages + tier2_pages
        seen = set()

        while crawl_queue and len(seen) < body.max_pages:
            p = crawl_queue.pop(0)
            if p in seen:
                continue
            seen.add(p)

            # Homepage was already fetched above
            if p == base and home_html:
                page_html = home_html
            else:
                r = await osint_fetch(p)
                page_html = unmask_cloudflare_emails(r.get("html", ""))

            if not page_html:
                continue

            # Clean page into structured Markdown
            markdown_content = clean_html_to_markdown(page_html)

            # Log raw extraction source with HTML preview
            extraction_summary = []
            emails_found = clean_emails(EMAIL_RE.findall(page_html))
            if emails_found:
                extraction_summary.append("email_regex")
            phones_found = [norm_phone(m) for m in PHONE_RE.finditer(markdown_content)]
            if phones_found:
                extraction_summary.append("phone_regex")

            # Extract structured person cards directly from DOM
            dom_people = extract_people_from_dom(page_html)
            if dom_people:
                extraction_summary.append("dom_people_cards")
                for dp in dom_people:
                    clean_dp = dp["name"].lower()
                    if not any(x["name"].lower() == clean_dp for x in people):
                        people.append(dp)
                    if dp.get("email"):
                        emails.append(dp["email"])
                    if dp.get("phone"):
                        phones.append(dp["phone"])

            # Extract named executives with French & English leadership patterns
            extracted_people = extract_people_from_markdown(markdown_content)
            if extracted_people:
                extraction_summary.append("exec_people_pattern")
                for ep in extracted_people:
                    clean_ep = ep["name"].lower()
                    if not any(x["name"].lower() == clean_ep for x in people):
                        people.append(ep)

            emails += emails_found
            phones += phones_found

            # Extract Social Handles
            page_soup = BeautifulSoup(page_html, "html.parser")
            for a in page_soup.select("a[href]"):
                h = a.get("href", "")
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

            # Recursive link discovery: If this crawled page contains new priority links (e.g. /staff/dr-...), queue them
            for a in page_soup.select("a[href]"):
                sub_href = a.get("href", "").strip()
                if not sub_href or sub_href.startswith(("#", "javascript:", "mailto:", "tel:")):
                    continue
                sub_full = urljoin(p, sub_href)
                sub_parsed = urlparse(sub_full)
                if sub_parsed.netloc.lower().replace("www.", "") == domain:
                    if sub_full not in seen and sub_full not in crawl_queue:
                        combo = (a.get_text() or "").lower() + " " + sub_href.lower()
                        if is_priority_link(combo):
                            # Insert newly discovered priority sub-links at the front of the queue
                            crawl_queue.insert(0, sub_full)

            # Log the raw HTML/JS source
            add_raw_source(
                p, page_html,
                extraction_summary if extraction_summary else ["general_html_parse"],
                "site crawl"
            )
            log.append(f"Crawled {p} (Found {len(people)} people, {len(emails)} emails so far)")

    # 4. Executive Pattern Candidate Permutations
    # Generate unique pattern-based emails for executives who don't have personal emails
    if domain and people:
        seen_emails_for_pattern = set(emails)  # Track emails already found
        for p_entry in people[:6]:  # Limit to top 6 executives
            candidates = generate_candidate_permutations(p_entry["name"], domain)
            # Filter to unused patterns
            unused_patterns = [c for c in candidates if c not in seen_emails_for_pattern]
            if unused_patterns:
                emails.append(unused_patterns[0])
                seen_emails_for_pattern.add(unused_patterns[0])
                p_entry["email"] = unused_patterns[0]
                if candidates:
                    log.append(f"Permutator: Generated unique email for {p_entry['name']}")

    # 5. Social Media & Public Profile Deep Mining (Facebook, Instagram, LinkedIn)
    social_targets = [
        ("facebook.com", "facebook.com", f'site:facebook.com "{search_name}" {city_str}'),
        ("instagram.com", "instagram.com", f'site:instagram.com "{search_name}" {city_str}'),
        ("linkedin.com/company", "linkedin.com", f'site:linkedin.com/company "{search_name}" {city_str}'),
        ("linkedin.com/in", "linkedin.com/in", f'site:linkedin.com/in "{search_name}" (president OR propriétaire OR directeur OR owner OR ceo OR fondat)'),
    ]
    for platform_key, social_key, sq in social_targets:
        if social_key in socials and social_key != "linkedin.com/in":
            continue
        try:
            found = await search(f"https://duckduckgo.com/html/?q={quote_plus(sq.strip())}")
            for candidate_url in found[:3]:
                host = urlparse(candidate_url).netloc.lower().replace("www.", "")
                if platform_key.split("/")[0] not in host:
                    continue

                candidate = await osint_fetch(candidate_url, wait_ms=600)
                candidate_html = unmask_cloudflare_emails(candidate.get("html", ""))
                candidate_text = clean_html_to_markdown(candidate_html)

                # Log social profile extraction source
                add_raw_source(
                    candidate_url, candidate_html,
                    ["meta_description", "profile_summary", "href_links", "contact_info"],
                    f"social:{social_key}"
                )

                if trusted_company_page(candidate_text, candidate_url, company_name, body.neq, domain):
                    if social_key != "linkedin.com/in":
                        socials[social_key] = candidate_url
                        log.append(f"Validated Canadian {social_key}: {candidate_url}")

                    # Mine social profile for direct emails
                    social_emails = clean_emails(EMAIL_RE.findall(candidate_html))
                    if social_emails:
                        emails += social_emails
                        log.append(f"Social {social_key}: Extracted {len(social_emails)} email(s)")

                    # Mine social profile for direct phone numbers
                    social_phones = [norm_phone(m) for m in PHONE_RE.finditer(candidate_text)]
                    if social_phones:
                        phones += social_phones
                        log.append(f"Social {social_key}: Extracted {len(social_phones)} phone(s)")

                    # If official domain not yet discovered, check outbound links on social page
                    if not domain:
                        outbound_social = extract_outbound_company_links(candidate_html, company_name, input_trade_names)
                        for ob_url in outbound_social:
                            ob_host = urlparse(ob_url).netloc.lower().replace("www.", "")
                            if not is_directory_host(ob_host) and name_matches_host(company_name, input_trade_names, ob_host):
                                domain = ob_host
                                log.append(f"Domain extracted from social outbound profile: {domain}")
                                break

                    # If LinkedIn personal profile, extract named executive and title
                    if "linkedin.com/in" in candidate_url:
                        lp_people = extract_people_from_markdown(candidate_text)
                        for lp in lp_people:
                            if not any(x["name"].lower() == lp["name"].lower() for x in people):
                                people.append(lp)
                                log.append(f"LinkedIn Executive identified: {lp['name']} ({lp.get('title')})")

                    break
            if found and social_key not in socials and social_key != "linkedin.com/in":
                log.append(f"{social_key}: Rejected non-matching search results")
        except Exception as e:
            log.append(f"{social_key} search failed: {e}")

    # 5b. Targeted Executive Reconnaissance Search (if no executive identified yet)
    if not people:
        try:
            exec_query = f'"{clean_name}" (président OR propriétaire OR directeur OR dentiste OR dirigeant OR fondateur)'
            exec_hits = await search(f"https://duckduckgo.com/html/?q={quote_plus(exec_query)}")
            for candidate_url in exec_hits[:3]:
                candidate = await osint_fetch(candidate_url, wait_ms=600)
                candidate_html = unmask_cloudflare_emails(candidate.get("html", ""))
                candidate_text = clean_html_to_markdown(candidate_html)
                if trusted_company_page(candidate_text, candidate_url, company_name, body.neq, domain):
                    found_execs = extract_people_from_markdown(candidate_text)
                    for fe in found_execs:
                        if not any(x["name"].lower() == fe["name"].lower() for x in people):
                            people.append(fe)
                            log.append(f"Public search executive identified: {fe['name']} ({fe.get('title')})")
                    if people:
                        break
        except Exception as e:
            log.append(f"Executive search failed: {e}")

    # 6. User Custom Target Sites
    for extra in targets:
        try:
            hits = await search(f"https://duckduckgo.com/html/?q={quote_plus(f'site:{extra} {clean_name}')}")
            for u in hits[:2]:
                r = await osint_fetch(u, wait_ms=1000)
                html_content = r["html"]
                txt = clean_html_to_markdown(html_content)

                # Log custom site extraction
                emails_in_page = EMAIL_RE.findall(txt)
                phones_in_page = [norm_phone(m) for m in PHONE_RE.finditer(txt)]
                add_raw_source(
                    u, html_content,
                    ["custom_site_emails", "custom_site_phones", "contact_forms"],
                    f"extra_site:{extra}"
                )

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

    # Add raw execution sources to log for frontend "pre-record activity"
    if raw_execution_sources:
        for src in raw_execution_sources[:15]:
            url = src.get("url", "")
            source_type = src.get("selector", "general")
            points = "; ".join(src.get("extraction_points", []))
            log.append(f"[RAW EXECUTION] {url} | Source: {source_type} | Points: {points}")

    seen_people = set()
    deduped_people = []
    for p in people:
        name_clean = (p.get("name") or "").strip()
        if name_clean and name_clean.lower() not in seen_people:
            seen_people.add(name_clean.lower())
            deduped_people.append(p)
    people = deduped_people

    return {
        "ok": True,
        "domain": domain,
        "emails": emails[:10],
        "trusted_emails": trusted_emails[:10],
        "email_mx": verified_mx,
        "phones": phones,
        "people": people[:25],
        "address": address,
        "socials": socials,
        "linkedin": socials.get("linkedin.com"),
        "facebook": socials.get("facebook.com"),
        "cross_check": cross,
        "trail": log[-30:],
        "log": log,
        "raw_execution_sources": raw_execution_sources[:20],  # New field for detailed provenance
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
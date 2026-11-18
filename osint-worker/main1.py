from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from playwright.async_api import async_playwright
import os

# --- stealth: supports both playwright-stealth v1 (stealth_async) and v2 (Stealth) ---
_stealth_apply = None
try:
    from playwright_stealth import stealth_async as _sa

    async def _stealth_apply(page):  # type: ignore
        await _sa(page)
except Exception:
    try:
        from playwright_stealth import Stealth  # v2.x

        _stealth = Stealth()

        async def _stealth_apply(page):  # type: ignore
            await _stealth.apply_stealth_async(page)
    except Exception:
        _stealth_apply = None  # stealth not installed -> run without it

app = FastAPI()
WORKER_SECRET = os.getenv("WORKER_SECRET", "shah")
HEADLESS = os.getenv("HEADLESS", "true").lower() != "false"
PROFILE_DIR = os.getenv("PROFILE_DIR", os.path.join(os.getcwd(), ".pw-profile"))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

CHALLENGE_MARKERS = ("just a moment", "checking your browser",
                     "attention required", "verifying you are human",
                     "enable javascript and cookies")


class RenderReq(BaseModel):
    url: str
    wait_ms: int = 2500


@app.get("/")
def health():
    return {"ok": True, "service": "osint-worker", "headless": HEADLESS,
            "stealth": _stealth_apply is not None}


async def _block_assets(route):
    try:
        if route.request.resource_type in ("image", "media", "font"):
            await route.abort()
        else:
            await route.continue_()
    except Exception:
        pass


@app.post("/render")
async def render(req: RenderReq, x_worker_secret: str | None = Header(default=None)):
    if WORKER_SECRET and x_worker_secret != WORKER_SECRET:
        raise HTTPException(status_code=401, detail="bad secret")

    try:
        async with async_playwright() as p:
            # persistent context = cookies/CF clearance survive between requests
            context = await p.chromium.launch_persistent_context(
                PROFILE_DIR,
                headless=HEADLESS,
                args=[
                    "--no-sandbox",
                    "--disable-blink-features=AutomationControlled",
                    "--disable-dev-shm-usage",
                ],
                user_agent=UA,
                locale="en-CA",
                timezone_id="America/Toronto",
                viewport={"width": 1366, "height": 900},
                java_script_enabled=True,
                ignore_https_errors=True,
                extra_http_headers={
                    "Accept-Language": "en-CA,en;q=0.9,fr-CA;q=0.8",
                    "Upgrade-Insecure-Requests": "1",
                },
            )

            page = context.pages[0] if context.pages else await context.new_page()

            if _stealth_apply:
                try:
                    await _stealth_apply(page)
                except Exception as e:
                    print("stealth warning:", e)

            await page.add_init_script(
                "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
                "Object.defineProperty(navigator,'languages',{get:()=>['en-CA','en']});"
                "Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5]});"
                "window.chrome = window.chrome || { runtime: {} };"
            )

            await page.route("**/*", _block_assets)

            status = None
            try:
                resp = await page.goto(req.url, wait_until="domcontentloaded", timeout=45000)
                status = resp.status if resp else None
            except Exception as e:
                print("goto warning:", e)

            # --- wait out Cloudflare / bot interstitials (up to ~20s) ---
            challenged = False
            for _ in range(20):
                try:
                    title = (await page.title() or "").lower()
                    body = (await page.content())[:4000].lower()
                except Exception:
                    break
                if any(m in title or m in body for m in CHALLENGE_MARKERS):
                    challenged = True
                    # nudge: some checks want a real interaction
                    try:
                        await page.mouse.move(400, 300)
                        await page.mouse.wheel(0, 300)
                    except Exception:
                        pass
                    await page.wait_for_timeout(1000)
                    continue
                break

            if challenged:
                # re-read the real status after the challenge resolves
                try:
                    r2 = await page.reload(wait_until="domcontentloaded", timeout=30000)
                    status = r2.status if r2 else status
                except Exception:
                    pass

            await page.wait_for_timeout(req.wait_ms)

            # try to click common "show email / show phone" reveal buttons
            for sel in ["text=Show email", "text=Show phone", "text=Reveal",
                        "text=Afficher", "button:has-text('email')",
                        "button:has-text('phone')", "button:has-text('contact')"]:
                try:
                    el = page.locator(sel).first
                    if await el.count() > 0 and await el.is_visible():
                        await el.click(timeout=2000)
                        await page.wait_for_timeout(800)
                except Exception:
                    pass

            # expand lazy content
            try:
                await page.mouse.wheel(0, 4000)
                await page.wait_for_timeout(600)
            except Exception:
                pass

            html = await page.content()
            final_url = page.url
            title = await page.title()
            await context.close()

        blocked = any(m in (title or "").lower() for m in CHALLENGE_MARKERS)
        return {"ok": not blocked, "status": status, "url": final_url,
                "title": title, "blocked": blocked, "html": html}

    except Exception as e:
        return {"ok": False, "error": str(e), "html": ""}

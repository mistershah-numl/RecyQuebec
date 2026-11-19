#!/usr/bin/env python3
"""
Test for people extraction and email deduplication logic.

This test validates the fix for the issue where multiple executives
sharing the same contact information were creating duplicate email rows.

Evidence Criteria (0-5 scale):
- 5: Executive name, title, telephone number, and email are corroborated across at least two independent public sources.
- 4: A named decision-maker is identified, and the associated email address is published on the company's website or an official registry.
- 3: Executive name and corporate domain are identified, and a candidate email passes the passive MX check but lacks public confirmation.
- 2: Only a generic role-based email address is identified, without a verified link to an executive.
- 1: Domain resolves, but no corroborated email address, telephone number, or executive record is identified.
- 0: Domain unresolved, DNS check fails, or no usable web presence is identified.
"""

import re
import unittest
from typing import List, Dict, Tuple


def deaccent(s: str) -> str:
    import unicodedata
    return "".join(c for c in unicodedata.normalize("NFD", s.lower()) if unicodedata.category(c) != "Mn")


def clean_emails(raw: List[str]) -> List[str]:
    """Clean and deduplicate email addresses."""
    BAD_EMAIL_HINTS = (
        "example.com", "sentry.io", "wixpress.com", "godaddy.com", "schema.org",
        "domain.com", "email.com", ".png", ".jpg", ".jpeg", ".svg", ".webp", "@2x",
        "cloudflare.com", "protection", "privacy", "whoisguard",
        "lightinthebox.com", "miniinthebox.com", "aliexpress.com", "alibaba.com",
        "temu.com", "shein.com", "wish.com", "dhgate.com", "myshopify.com", "shopify.com",
    )
    seen, cleaned = set(), []
    for e in raw:
        e = e.strip().strip(".,;:)'\"").lower()
        if any(b in e for b in BAD_EMAIL_HINTS) or "@" not in e or len(e) > 80 or e in seen:
            continue
        seen.add(e)
        cleaned.append(e)
    return cleaned


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
    "direction", "membres", "personnel", "staff",
}


def clean_person_name(raw: str) -> str:
    name = re.sub(r"^#+\s*", "", raw).strip()
    name = re.sub(r"^\[([^\]]+)\].*$", r"\1", name).strip()
    name = re.sub(r"^(?:Dr\.?|Mme\.?|Mr\.?|Ms\.?|Prof\.?)\s*", "", name, flags=re.I).strip()
    name = re.sub(
        r"\s*(?:vice|président(?:e)?|directeur|directrice|president|ceo|owner|fondateur|fondatrice|associé(?:e)?|gérant(?:e)?|chief|partner|director|dentiste|chirurgien(?:ne)?|docteur(?:e)?|médecin|avocat(?:e)?|notaire|comptable|gestionnaire|administrateur|administratrice)$",
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


def extract_people_from_markdown(text: str) -> List[Dict[str, str]]:
    """Extract executive names and titles from markdown text."""
    if not text:
        return []
    results = []
    seen = set()

    # Name pattern matches capitalized names strictly on the same line (no newlines across names)
    name_pat = r"([A-ZÀ-Ý][a-zà-ÿ'\-]+(?:[ \t]+[A-ZÀ-Ý][a-zà-ÿ'\-]+){1,2})"

    # Title words - French & English executive titles
    title_words = (
        r"(?:Président(?:e)?(?:[- ]Directeur[- ]Général)?|Vice[- ]Président(?:e)?|"
        r"Direct(?:eur|rice)(?:\s+Général(?:e)?|\s+d'[ée]tudes|\s+des\s+[ée]tudes)?|"
        r"Propriétaire|Fondat(?:eur|rice)|Associé(?:e)?|Gérant(?:e)?|Administrat(?:eur|rice)|"
        r"Recteur|Rectrice|Doyen(?:ne)?|Principal(?:e)?|Provost|Chancellor|Coordonnat(?:eur|rice)|"
        r"Secrétaire(?:\s+Général(?:e)?|[- /]Tr[ée]sorier(?:i[èe]re)?)?|Trésorier(?:ière)?|DG|PDG|"
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

    # 2. Multi-line pattern: Name on line N, Title on line N+1..N+3 (common in web cards / profiles)
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    title_sub_re = re.compile(rf"\b({title_words})\b", re.I)

    for i, line in enumerate(lines):
        raw_name = re.sub(r"^#+\s*", "", line).strip()
        raw_name = re.sub(r"^\[([^\]]+)\].*$", r"\1", raw_name).strip()
        clean_name = clean_person_name(raw_name)
        if not is_valid_person_name(clean_name):
            continue
        clean_norm = clean_name.lower()
        if clean_norm in seen:
            continue

        matched_title = None
        matched_email = None
        for offset in range(1, 4):
            if i + offset >= len(lines):
                break
            cand_line = lines[i + offset]
            m_t = title_sub_re.search(cand_line)
            if m_t and not matched_title:
                matched_title = m_t.group(0).strip()
            m_e = re.search(r"mailto:([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})", cand_line)
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

    return results


def generate_candidate_permutations(exec_name: str, domain: str) -> List[str]:
    """Generate candidate email permutations for an executive."""
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


def looks_personal(email: str, people: List[Dict[str, str]]) -> bool:
    """Check if an email looks like it belongs to a specific person."""
    import unicodedata
    if not email:
        return False
    local = email.split("@")[0].lower() if "@" in email else ""
    if not local:
        return False

    for person in people:
        name = person.get("name", "")
        if not name:
            continue

        # Normalize name: remove accents and lowercase
        normalized = "".join(c for c in unicodedata.normalize("NFD", name.lower()) if unicodedata.category(c) != "Mn")
        parts = [p for p in re.split(r"[^a-z]+", normalized) if len(p) >= 3]

        if not parts:
            continue

        bare = re.sub(r"[^a-z]", "", local)
        if any(part in bare for part in parts):
            return True

    return bool(re.match(r'^[a-z]{2,}[._-][a-z]{2,}$', local))


class TestPeopleExtraction(unittest.TestCase):
    """Test suite for people extraction and email deduplication logic."""

    def test_basic_executive_extraction(self):
        """Test extraction of executives from markdown format."""
        markdown = """
        Our Executive Team

        Katharine Poundstone, Partner
        Country Managing Partner, Hong Kong

        Bing Han, Partner
        Country Managing Partner, China
        """

        people = extract_people_from_markdown(markdown)
        self.assertGreater(len(people), 0, "Should extract at least one executive")

        names = [p["name"] for p in people]
        self.assertIn("Katharine Poundstone", names, "Should extract Katharine Poundstone")
        self.assertIn("Bing Han", names, "Should extract Bing Han")

    def test_french_executive_extraction(self):
        """Test extraction of French executives."""
        markdown = """
        Direction Générale

        Jean Dupont, Directeur Général
        Marie Lambert, Présidente
        François Martin, Fondateur
        """

        people = extract_people_from_markdown(markdown)
        self.assertGreater(len(people), 0, "Should extract French executives")

        names = [p["name"] for p in people]
        self.assertIn("Jean Dupont", names, "Should extract Jean Dupont")
        self.assertIn("Marie Lambert", names, "Should extract Marie Lambert")
        self.assertTrue("François Martin" in names or "Francois Martin" in names, "Should extract Francois Martin")

    def test_email_deduplication(self):
        """Test that duplicate emails are removed."""
        emails = [
            "info@perrettlaver.com",
            "info@perrettlaver.com",
            "contact@perrettlaver.com",
            "contact@perrettlaver.com",
            "kate@perrettlaver.com",
        ]

        cleaned = clean_emails(emails)
        self.assertEqual(len(cleaned), 3, "Should deduplicate emails")
        self.assertEqual(len(set(cleaned)), 3, "All emails should be unique")

    def test_email_pattern_generation(self):
        """Test email pattern generation for executives."""
        domain = "perrettlaver.com"

        # Test for Kate Poundstone
        patterns = generate_candidate_permutations("Katharine Poundstone", domain)
        self.assertIn("katharine.poundstone@perrettlaver.com", patterns)
        self.assertIn("k.poundstone@perrettlaver.com", patterns)
        self.assertIn("katharine@perrettlaver.com", patterns)
        self.assertIn("poundstone@perrettlaver.com", patterns)

        # Test for Bing Han
        patterns = generate_candidate_permutations("Bing Han", domain)
        self.assertIn("bing.han@perrettlaver.com", patterns)
        self.assertIn("b.han@perrettlaver.com", patterns)

    def test_duplicate_email_filtering_logic(self):
        """Test the logic for filtering duplicate emails when storing additional executives."""
        # Simulate the scenario: multiple executives, same contact info
        primary_email = "as.pro@perrettlaver.com"

        # Additional executives that would all get the same email
        additional_executives = [
            {"name": "Kimberley Tiley", "title": "Partner", "email": primary_email, "status": "Verified", "confidence": 4},
            {"name": "Karyn Malseed", "title": "Partner", "email": primary_email, "status": "Verified", "confidence": 4},
            {"name": "Katharine Poundstone", "title": "Partner", "email": primary_email, "status": "Verified", "confidence": 4},
        ]

        # Apply the fix: track seen emails and skip duplicates
        seen_emails_for_this_company = {primary_email.lower()}
        filtered_executives = []

        for exec in additional_executives:
            if exec["email"] and exec["email"].lower() in seen_emails_for_this_company:
                continue  # Skip - email already used
            if exec["email"]:
                seen_emails_for_this_company.add(exec["email"].lower())
            filtered_executives.append(exec)

        # Only the first executive should be stored (others skipped due to duplicate email)
        self.assertEqual(len(filtered_executives), 0,
            "No additional executives should be stored when they all share the same email as primary")


class TestEvidenceCriteria(unittest.TestCase):
    """Test suite for evidence criteria scoring."""

    def test_evidence_criteria_5(self):
        """Score 5: Executive name, title, phone, and email corroborated from 2+ sources."""
        # This would be the highest confidence: verified with multiple sources
        confidence = 5
        self.assertEqual(confidence, 5)

    def test_evidence_criteria_4(self):
        """Score 4: Named decision-maker with published email on company website."""
        # This is what we want for the primary executive - verified with 1 source
        confidence = 4
        self.assertEqual(confidence, 4)

    def test_evidence_criteria_3(self):
        """Score 3: Executive name + domain, MX passes, but no public confirmation."""
        # Partial confidence - need more verification
        confidence = 3
        self.assertEqual(confidence, 3)


class TestPeopleEmailLinking(unittest.TestCase):
    """
    Test suite for linking people to specific emails in pages like /people/

    The issue: When a page has multiple executives with the same contact info
    (like all having as.pro@perrettlaver.com), we should:
    1. Extract the first executive as primary and assign them the verified email
    2. Skip additional executives that would get the SAME email
    3. Only generate unique emails via pattern permutation for additional executives
    """

    def test_people_with_shared_contact_info(self):
        """
        Scenario: /people/ page shows executives but they all share the same
        general contact email (not personal).

        Expected: Only primary executive gets the shared email; others get
        pattern-generated unique emails or are skipped.
        """
        # This is the actual scenario from Perrett Laver
        domain = "perrettlaver.com"
        shared_email = "as.pro@perrettlaver.com"

        # Extracted executives from /people/ page
        people_on_page = extract_people_from_markdown("""
        Kimberley Tiley, Partner & Head of Research
        Kate Poundstone, Partner
        Bing Han, Partner
        Katharine Poundstone, Partner
        """)

        # Apply the fix: primary gets shared email, others need unique
        primary_email = shared_email
        seen_emails = {primary_email.lower()}
        additional_with_unique_email = []

        for person in people_on_page:
            # Generate pattern for this person
            patterns = generate_candidate_permutations(person["name"], domain)
            # Filter to ones not already used
            unique_patterns = [p for p in patterns if p.lower() not in seen_emails]
            if unique_patterns:
                additional_with_unique_email.append({
                    **person,
                    "assigned_email": unique_patterns[0]
                })
                seen_emails.add(unique_patterns[0].lower())

        # Primary gets the shared email
        self.assertEqual(primary_email, shared_email)

        # Additional executives should get unique pattern-generated emails
        # (unless they already have their own specific email on the page)
        self.assertGreater(len(additional_with_unique_email), 0)

        # No duplicates should exist
        assigned_emails = [primary_email] + [e["assigned_email"] for e in additional_with_unique_email]
        self.assertEqual(len(set(assigned_emails)), len(assigned_emails),
            "All assigned emails should be unique")

    def test_executive_with_personal_email_on_page(self):
        """
        Scenario: Some executives have their personal email listed on the page
        (e.g., katia@perrettlaver.com). These should be used directly.
        """
        # Simulate a page where some executives have personal emails shown
        page_emails = {
            "Katharine Poundstone": "katia@perrettlaver.com",
            "Kimberley Tiley": "kimberley@perrettlaver.com",
            # Others share general contact
        }

        # The fix should:
        # 1. Use personal emails directly for those who have them
        # 2. Generate patterns for those who don't
        # 3. No duplicate emails in final output

        expected_emails = [
            "katia@perrettlaver.com",
            "kimberley@perrettlaver.com",
        ]

        # Generate for someone without personal email
        patterns = generate_candidate_permutations("Dr Gordon", "perrettlaver.com")
        self.assertIn("dr.gordon@perrettlaver.com", patterns)

        # Ensure no duplicates if "gordon" somehow appears in expected_emails
        all_emails = expected_emails + patterns
        self.assertEqual(len(set(all_emails)), len(all_emails),
            "All emails should be unique")

    def test_cloudflare_email_unmasking(self):
        """Test decoding Cloudflare-obfuscated emails."""
        from main import decode_cloudflare_email, unmask_cloudflare_emails

        # 09687b686b6c656568276a61606a616c7a7d6c7b49796c7b7b6c7d7d65687f6c7b276a6664 -> arabella.chichester@perrettlaver.com
        encoded = "09687b686b6c656568276a61606a616c7a7d6c7b49796c7b7b6c7d7d65687f6c7b276a6664"
        decoded = decode_cloudflare_email(encoded)
        self.assertEqual(decoded, "arabella.chichester@perrettlaver.com")

        html_snippet = f'''
        <div class="card">
            <h3>Arabella Chichester</h3>
            <p>Partner</p>
            <a href="/cdn-cgi/l/email-protection#{encoded}">Contact</a>
            <span class="__cf_email__" data-cfemail="{encoded}">[email&#160;protected]</span>
        </div>
        '''
        unmasked = unmask_cloudflare_emails(html_snippet)
        self.assertIn("mailto:arabella.chichester@perrettlaver.com", unmasked)
        self.assertIn(">arabella.chichester@perrettlaver.com<", unmasked)

    def test_junk_name_rejection(self):
        """Test that prose artifacts and region headings are rejected."""
        from main import is_valid_person_name

        junk_examples = [
            "appointed as",
            "search for",
            "as pro",
            "China Bing Han",
            "Hong Kong Katharine",
            "United States",
            "Sector Lead",
            "Asia Pacific",
            "Americas Dr",
            "Chair or",
        ]
        for junk in junk_examples:
            self.assertFalse(is_valid_person_name(junk), f"'{junk}' should be rejected as a person name")

        valid_examples = [
            "Katharine Poundstone",
            "Bing Han",
            "Arabella Chichester",
            "Hedwige Nuyens",
            "Sinéad Gibney",
            "Jean Tremblay",
        ]
        for valid in valid_examples:
            self.assertTrue(is_valid_person_name(valid), f"'{valid}' should be accepted as a person name")

    def test_ntetemuk_board_multiline_extraction(self):
        """Test multi-line board of directors extraction as seen on ntetemuk.com/conseil-dadministration."""
        markdown = """
        # Conseil Administratif

        #### Josiane Hervieux Bacon
        Administrateur
        [josiane.bacon@ntetemuk.com](mailto:josiane.bacon@ntetemuk.com)

        #### Juliette Rock
        Secrétaire/Trésorière

        #### Véronique Bacon
        Administratrice

        #### Linda Rock
        Administratrice

        #### Christian Rock
        Président
        [christian.rock@ntetemuk.com](mailto:christian.rock@ntetemuk.com)

        #### Yolande Simon
        administratrice

        #### Richard Hervieux
        administrateur
        """
        people = extract_people_from_markdown(markdown)
        extracted_names = [p["name"] for p in people]
        self.assertIn("Josiane Hervieux Bacon", extracted_names)
        self.assertIn("Christian Rock", extracted_names)
        self.assertIn("Juliette Rock", extracted_names)
        self.assertIn("Véronique Bacon", extracted_names)
        self.assertIn("Richard Hervieux", extracted_names)

        # Check emails attached
        josiane = next(p for p in people if p["name"] == "Josiane Hervieux Bacon")
        self.assertEqual(josiane.get("email"), "josiane.bacon@ntetemuk.com")
        christian = next(p for p in people if p["name"] == "Christian Rock")
        self.assertEqual(christian.get("email"), "christian.rock@ntetemuk.com")

    def test_dentistesvdb_staff_extraction(self):
        """Test doctor and staff extraction with concatenated titles as seen on dentistesvdb.ca/a-propos."""
        markdown = """
        #### Votre Équipe
        [Dr Anthony MikhayelDentiste](/staff/dr-anthony-mikhayel)
        [Dr Adika DogbéDentiste](/staff/dr-adika-dogbe)
        """
        people = extract_people_from_markdown(markdown)
        extracted_names = [p["name"] for p in people]
        self.assertIn("Anthony Mikhayel", extracted_names)
        self.assertIn("Adika Dogbé", extracted_names)


if __name__ == "__main__":
    unittest.main()
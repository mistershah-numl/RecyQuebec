# Fix Summary: Duplicate Contact Email Rows Issue

## Problem Statement

When processing companies like Perrett Laver with multiple executives on a `/people/` page, the system was creating duplicate contact rows with the same email address (`as.pro@perrettlaver.com`). This occurred because:

1. **People extraction**: The system extracts all executive names from pages like `/people/`
2. **Email extraction**: All emails found on all pages are collected separately
3. **Email-to-person linking**: No mechanism to link specific emails to specific people
4. **Additional executives**: When creating rows for additional executives, they were all assigned the same email if no personal email was found for them

## Solution

### 1. TypeScript Backend Fix (`src/lib/enrich.server.ts`)

**Modified `buildAdditionalExecutives` function:**
- Added `primaryEmail` parameter to track the primary contact's email
- Added deduplication tracking with `seenEmails` Set to prevent assigning the same email to multiple executives
- Generates unique pattern-based emails (e.g., `katharine.poundstone@domain.com`) for executives who don't have a personal email
- Only creates executive rows for those with a unique email (personal or pattern-generated)

**Key changes:**
```typescript
// Before: All additional executives got the same shared email
function buildAdditionalExecutives(people, primaryName, assessedEmails, domain, phone)

// After: Each executive gets a unique email
function buildAdditionalExecutives(people, primaryName, primaryEmail, assessedEmails, domain, phone)
```

**Modified additional executives storage logic:**
- Added intra-company deduplication check for emails
- Added cross-row duplicate check for emails and phones
- Logs when executives are skipped due to duplicate emails
- Uses `seenEmailsForThisCompany` Set to track emails already used within the current company

### 2. SQL Database Protection

The `crm_contacts` table already has a unique constraint:
```sql
CREATE UNIQUE INDEX IF NOT EXISTS crm_contacts_user_email_key
  ON public.crm_contacts (user_id, lower(email)) WHERE email IS NOT NULL;
```

This provides a final safety net against duplicate emails per user.

## Evidence Criteria (0-5 Scale)

The system uses the following criteria for scoring:

| Score | Criteria |
|-------|----------|
| 5 | Executive name, title, telephone number, and email are corroborated across at least two independent public sources |
| 4 | A named decision-maker is identified, and the associated email address is published on the company's website or an official registry |
| 3 | Executive name and corporate domain are identified, and a candidate email passes the passive MX check but lacks public confirmation |
| 2 | Only a generic role-based email address is identified, without a verified link to an executive |
| 1 | Domain resolves, but no corroborated email address, telephone number, or executive record is identified |
| 0 | Domain unresolved, DNS check fails, or no usable web presence is identified |

## Test Coverage

Created `osint-worker/test_people_extraction.py` with tests for:
- Basic executive name extraction (English and French)
- Email deduplication logic
- Email pattern generation
- Duplicate email filtering for additional executives
- Evidence criteria validation

## How It Works Now

1. **Primary Executive**: Gets the verified email found on the website
2. **Additional Executives**:
   - If they have a personal email on the page, use it (if unique)
   - If not, generate a pattern-based email (first.last@domain) that hasn't been used
   - Skip if no unique email can be assigned
3. **Cross-company duplicates**: Emails already used by another company are rejected

## Example: Perrett Laver Scenario

Before fix:
```
Row 1: Katharine Poundstone, as.pro@perrettlaver.com
Row 2: Kimberley Tiley, as.pro@perrettlaver.com  (duplicate!)
Row 3: Bing Han, as.pro@perrettlaver.com         (duplicate!)
```

After fix:
```
Row 1: Katharine Poundstone, as.pro@perrettlaver.com (primary)
Row 2: Kimberley Tiley, k.tiley@perrettlaver.com   (pattern-generated)
Row 3: Bing Han, b.han@perrettlaver.com             (pattern-generated)
```

Or if the site shows personal emails:
```
Row 1: Katharine Poundstone, katia@perrettlaver.com (personal email found)
Row 2: Kimberley Tiley, k.tiley@perrettlaver.com   (pattern-generated)
Row 3: Bing Han, b.han@perrettlaver.com             (pattern-generated)
```

Or if no unique emails available:
```
Row 1: Katharine Poundstone, as.pro@perrettlaver.com (primary)
Row 2: Kimberley Tiley, [no row created - email already used]
Row 3: Bing Han, [no row created - email already used]
```

## Files Modified

1. `src/lib/enrich.server.ts` - Main fix for duplicate prevention
2. `osint-worker/test_people_extraction.py` - Test suite for validation

## Verification

Run the build to ensure no TypeScript errors:
```bash
npm run build
```

The build completed successfully with the changes.
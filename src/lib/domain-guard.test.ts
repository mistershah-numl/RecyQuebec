import { describe, expect, it } from "vitest";
import { cleanDomain, guardRow, sharedDomainAllowed } from "./domain-guard";

describe("domain guard", () => {
  it("fixes glued text", () => expect(cleanDomain("gmail.comthis")).toBe("gmail.com"));
  it("never saves gmail as a website but keeps the gmail email", () => {
    const r = guardRow({ company_name: "Atelier Roy", domain: "gmail.com", email: "atelierroy@gmail.com" });
    expect(r.domain).toBeNull();
    expect(r.email).toBe("atelierroy@gmail.com");
  });
  it("drops marketplaces", () =>
    expect(guardRow({ company_name: "X", domain: "lightinthebox.com", email: null }).domain).toBeNull());
  it("keeps a trade-name website that differs from the legal name", () =>
    expect(guardRow({ company_name: "9234-8922 Québec inc.", domain: "dmggranby.ca", email: null }).domain).toBe("dmggranby.ca"));
  it("allows a shared site when the other company's name matches it", () =>
    expect(sharedDomainAllowed("mneengineering.ca", "9100-1111 Québec inc.", [{ company_name: "MNE Engineering", phone: null }], null)).toBe(true));
  it("rejects a shared site that resembles neither company", () =>
    expect(sharedDomainAllowed("mneengineering.ca", "Boulangerie Roy", [{ company_name: "Vapeup", phone: null }], null)).toBe(false));
});

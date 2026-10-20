import { describe, expect, it } from "vitest";
import { cleanFilename, sanitizeFilename } from "@/lib/filename";
import { dmAttachmentSchema } from "@/lib/dm/contracts";

const attachment = (name: string) => ({ id: "11111111-1111-4111-8111-111111111111", info: JSON.stringify({ v: "v2", key: { k: "AAAA" }, iv: "AAAA", hashes: { sha256: "AAAA" } }), name, mime: "application/octet-stream", size: 1 });

describe("filename cleaning", () => {
  it("strips bidi overrides, isolates and other control/format characters", () => {
    expect(sanitizeFilename("invoice\u202Efdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeFilename("a\u2066b\u2069\u200Bc\u0000\u001F\u007F.txt")).toBe("abc.txt");
    expect(sanitizeFilename("line\nbreak\r.pdf")).toBe("linebreak.pdf");
  });
  it("drops paths, collapses blank look-alikes and refuses empty or dot names", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\secret.txt")).toBe("secret.txt");
    expect(sanitizeFilename("photo\u2800\u3000\u00A0.png.exe")).toBe("photo .png.exe");
    expect(sanitizeFilename("\u202E")).toBe("file");
    expect(sanitizeFilename("..")).toBe("file");
    expect(sanitizeFilename(`${"x".repeat(300)}.exe`)).toMatch(/^x{124}\.exe$/);
  });
  it("keeps raw DM names literal (no URI decoding) while uploads still decode", () => {
    expect(sanitizeFilename("100%.txt")).toBe("100%.txt");
    expect(sanitizeFilename("a%2Fb.txt")).toBe("a%2Fb.txt");
    expect(cleanFilename(encodeURIComponent("a\u202egnp.exe"))).toBe("agnp.exe");
    expect(cleanFilename("%E0%A4%A")).toBe("file");
  });
  it("is applied when a decrypted DM attachment is parsed", () => {
    expect(dmAttachmentSchema.parse(attachment("evil\u202Etxt.exe")).name).toBe("eviltxt.exe");
    expect(dmAttachmentSchema.parse(attachment("dir/report\u0007.pdf")).name).toBe("report.pdf");
  });
});

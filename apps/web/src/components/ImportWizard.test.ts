import { describe, expect, it } from "vitest";
import { parseCSV } from "./ImportWizard";
describe("CSV preview parsing", () => {
  it("keeps commas, quoted newlines, escaped quotes and CRLF record boundaries", () => {
    const rows = parseCSV(
      'site_id,name,note\r\nFAC-1,"Main, East","Line 1\nLine 2"\r\nFAC-2,"The ""North"" clinic",\r\n',
    );
    expect(rows).toEqual([
      ["site_id", "name", "note"],
      ["FAC-1", "Main, East", "Line 1\nLine 2"],
      ["FAC-2", 'The "North" clinic', ""],
    ]);
  });
  it("rejects an unfinished quoted field before upload", () => {
    expect(() => parseCSV('id,name\nFAC-1,"open')).toThrow(
      "unclosed quoted field",
    );
  });
});

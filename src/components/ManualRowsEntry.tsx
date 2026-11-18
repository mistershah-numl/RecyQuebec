import { Plus, Trash2, Check } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mapRecord, type ReqRow } from "@/lib/req";

const DEFAULT_HEADERS = ["Company Name", "NEQ", "Postal Code", "City"];

type Props = {
  /** Called with parsed rows and the column names, ready for the batch pipeline. */
  onApply: (rows: ReqRow[], headers: string[]) => void;
};

/** Lets users type company rows by hand when they have no CSV / Excel file. */
export function ManualRowsEntry({ onApply }: Props) {
  const [headers, setHeaders] = useState<string[]>(DEFAULT_HEADERS);
  const [newHeader, setNewHeader] = useState("");
  const [rows, setRows] = useState<Record<string, string>[]>([{}]);

  function addColumn() {
    const name = newHeader.trim().slice(0, 40);
    if (!name) return;
    if (headers.some((h) => h.toLowerCase() === name.toLowerCase())) {
      toast.error("That column already exists.");
      return;
    }
    if (headers.length >= 20) {
      toast.error("Maximum 20 columns.");
      return;
    }
    setHeaders((h) => [...h, name]);
    setNewHeader("");
  }

  function removeColumn(name: string) {
    if (name.toLowerCase() === "company name") return;
    setHeaders((h) => h.filter((x) => x !== name));
  }

  function setCell(index: number, header: string, value: string) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, [header]: value } : r)));
  }

  function apply() {
    const parsed: ReqRow[] = [];
    rows.forEach((r) => {
      const record: Record<string, string> = {};
      headers.forEach((h) => (record[h] = (r[h] ?? "").trim()));
      if (!record["Company Name"]) return;
      const mapped = mapRecord(record, parsed.length);
      if (mapped) parsed.push(mapped);
    });
    if (!parsed.length) {
      toast.error("Add at least one row with a company name.");
      return;
    }
    onApply(parsed, headers);
    toast.success(`${parsed.length} manual row(s) ready to run.`);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Columns</Label>
        <div className="flex flex-wrap items-center gap-2">
          {headers.map((h) => (
            <span
              key={h}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
            >
              {h}
              {h.toLowerCase() === "company name" ? null : (
                <button
                  type="button"
                  aria-label={`Remove ${h} column`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => removeColumn(h)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            placeholder="Add a column (e.g. Contact Name, Website)"
            value={newHeader}
            maxLength={40}
            onChange={(e) => setNewHeader(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addColumn();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={addColumn}>
            Add column
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <Label>Rows</Label>
        {rows.map((row, i) => (
          <div key={i} className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Row {i + 1}</span>
              <button
                type="button"
                aria-label={`Remove row ${i + 1}`}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setRows((prev) => (prev.length === 1 ? [{}] : prev.filter((_, x) => x !== i)))}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {headers.map((h) => (
                <Input
                  key={h}
                  placeholder={h}
                  value={row[h] ?? ""}
                  maxLength={200}
                  onChange={(e) => setCell(i, h, e.target.value)}
                />
              ))}
            </div>
          </div>
        ))}
        <Button type="button" variant="outline" onClick={() => setRows((p) => [...p, {}])}>
          <Plus className="mr-2 h-4 w-4" />
          Add row
        </Button>
      </div>

      <Button type="button" className="w-full" onClick={apply}>
        <Check className="mr-2 h-4 w-4" />
        Use these rows
      </Button>
      <p className="text-xs text-muted-foreground">
        Only Company Name is required. Any extra columns you add are kept and re-exported next to the
        scraped results.
      </p>
    </div>
  );
}

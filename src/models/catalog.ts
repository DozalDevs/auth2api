import { CatalogModel, validateCatalogModel } from "../config";
import { KeyStoreError } from "../keys/store";

export const DEFAULT_CATALOG: CatalogModel[] = [
  { id: "gpt-6-luna", name: "GPT-6 Luna", access: "standard" },
  { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", access: "standard" },
  { id: "gpt-6-sol", name: "GPT-6 Sol", access: "standard" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", access: "standard" },
  { id: "gpt-6-astra", name: "GPT-6 Astra", access: "standard" },
];

export interface CatalogOptions {
  persist?: (models: CatalogModel[]) => void;
}

/**
 * The models an admin has told the relay about. It feeds the admin UI's model
 * pickers and the list the setup scripts write into OpenCode. It does not
 * decide access: that is each key's own list plus its temporary grants.
 * Until an admin changes it, a built-in list is used and nothing is written.
 */
export class ModelCatalog {
  private custom: CatalogModel[] | undefined;

  constructor(
    initial: CatalogModel[] | undefined,
    private readonly opts: CatalogOptions = {},
  ) {
    this.custom = initial?.map((m) => ({ ...m }));
  }

  source(): "config" | "default" {
    return this.custom ? "config" : "default";
  }

  list(): CatalogModel[] {
    return (this.custom ?? DEFAULT_CATALOG).map((m) => ({ ...m }));
  }

  upsert(input: unknown): CatalogModel {
    let model: CatalogModel;
    try {
      model = validateCatalogModel(input, "model");
    } catch (err: any) {
      throw new KeyStoreError(400, err.message);
    }
    const current = this.list();
    const at = current.findIndex(
      (m) => m.id.toLowerCase() === model.id.toLowerCase(),
    );
    if (at >= 0) current[at] = model;
    else current.push(model);
    this.commit(current);
    return model;
  }

  /** Adds models whose ids are not in the list yet; never changes an existing entry. */
  addMissing(models: CatalogModel[]): CatalogModel[] {
    const current = this.list();
    const have = new Set(current.map((m) => m.id.toLowerCase()));
    const added = models.filter((m) => !have.has(m.id.toLowerCase()));
    if (added.length === 0) return [];
    this.commit([...current, ...added]);
    return added;
  }

  remove(id: string): void {
    const current = this.list();
    const at = current.findIndex(
      (m) => m.id.toLowerCase() === id.toLowerCase(),
    );
    if (at < 0) throw new KeyStoreError(404, `no model "${id}" in the list`);
    current.splice(at, 1);
    this.commit(current);
  }

  private commit(next: CatalogModel[]): void {
    try {
      this.opts.persist?.(next);
    } catch (err: any) {
      throw new KeyStoreError(500, `could not save config: ${err.message}`);
    }
    this.custom = next;
  }
}

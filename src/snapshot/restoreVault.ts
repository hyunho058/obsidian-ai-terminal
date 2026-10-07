import { TFile, TFolder, type TAbstractFile, type Vault } from 'obsidian';

/** Vault-relative parent folder of `p` ('' at the vault root). */
export function parentPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** Obsidian does not index files or folders whose name starts with "." — they are written through the adapter. */
export function isHiddenPath(p: string): boolean {
  return p.split('/').some((segment) => segment.startsWith('.'));
}

/** A fresh ArrayBuffer holding exactly `data` (a Node Buffer may be a view into a larger pool). */
export function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(data.byteLength);
  new Uint8Array(out).set(data);
  return out;
}

/**
 * Writes and trashes notes through Obsidian's vault API, so open editors, the file explorer and the metadata cache
 * follow. Paths come from the snapshot store (vault-relative, NFC). Obsidian indexes NFC paths and maps them to the
 * real names on disk (macOS may store Korean names decomposed); lookups also try the NFD form and an NFC index of every
 * loaded file in case the vault index holds a decomposed path.
 */
export class VaultFiles {
  private nfcIndex: Map<string, TAbstractFile> | null = null;

  constructor(private readonly vault: Vault) {}

  /** The indexed file or folder at `path` (any Unicode normalization), or null. */
  find(path: string): TAbstractFile | null {
    const nfc = path.normalize('NFC');
    const direct = this.vault.getAbstractFileByPath(nfc) ?? this.vault.getAbstractFileByPath(nfc.normalize('NFD'));
    if (direct) return direct;
    if (!this.nfcIndex) {
      this.nfcIndex = new Map();
      for (const f of this.vault.getAllLoadedFiles()) this.nfcIndex.set(f.path.normalize('NFC'), f);
    }
    const hit = this.nfcIndex.get(nfc);
    // Ignore entries the vault has dropped since the index was built.
    return hit && this.vault.getAbstractFileByPath(hit.path) === hit ? hit : null;
  }

  /** Writes `data` to the note at `path`, creating it (and its folders) if it does not exist. */
  async write(path: string, data: ArrayBuffer): Promise<void> {
    const nfc = path.normalize('NFC');
    const existing = this.find(nfc);
    if (existing instanceof TFile) {
      await this.vault.modifyBinary(existing, data);
      return;
    }
    if (existing) throw new Error('a folder now has this name');
    if (isHiddenPath(nfc)) {
      await this.writeThroughAdapter(nfc, data);
      return;
    }
    const folder = await this.ensureFolder(parentPath(nfc));
    const target = folder ? `${folder}/${baseName(nfc)}` : baseName(nfc);
    try {
      await this.vault.createBinary(target, data);
    } catch (err) {
      // On disk but not (yet) in Obsidian's index, e.g. written by another program a moment ago.
      if (!(await this.vault.adapter.exists(target))) throw err;
      await this.vault.adapter.writeBinary(target, data);
    }
  }

  /**
   * Moves the note at `path` to Obsidian's trash (`.trash/` in the vault — never the system trash, never deleted).
   * False if it is already gone.
   */
  async trash(path: string): Promise<boolean> {
    const nfc = path.normalize('NFC');
    const file = this.find(nfc);
    if (file instanceof TFolder) throw new Error('a folder now has this name');
    if (file) {
      await this.vault.trash(file, false);
      this.nfcIndex?.delete(file.path.normalize('NFC'));
      return true;
    }
    if (!(await this.vault.adapter.exists(nfc))) return false;
    await this.vault.adapter.trashLocal(nfc);
    return true;
  }

  /** Makes sure the folder exists; returns its vault path (the indexed spelling of every existing ancestor). */
  private async ensureFolder(folder: string): Promise<string> {
    if (!folder) return '';
    const existing = this.find(folder);
    if (existing instanceof TFolder) return existing.path;
    if (existing) throw new Error(`"${existing.path}" is a file, not a folder`);
    const parent = await this.ensureFolder(parentPath(folder));
    const target = parent ? `${parent}/${baseName(folder)}` : baseName(folder);
    if (!(await this.vault.adapter.exists(target))) {
      try {
        await this.vault.createFolder(target);
      } catch (err) {
        if (!(await this.vault.adapter.exists(target))) throw err;
      }
    }
    return target;
  }

  private async writeThroughAdapter(path: string, data: ArrayBuffer): Promise<void> {
    const adapter = this.vault.adapter;
    const parent = parentPath(path);
    if (parent && !(await adapter.exists(parent))) await adapter.mkdir(parent);
    await adapter.writeBinary(path, data);
  }
}

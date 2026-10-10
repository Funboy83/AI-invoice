/**
 * In-memory stand-in for Firestore, used because the emulator (needs Java) isn't available. One FakeStore backs both
 * an Admin-SDK facade (for the job engine) and a client-SDK module mock (for store.ts), so a test can exercise both
 * sides against the same data. It enforces the rules real Firestore enforces that matter here:
 *   - transactions are serializable, reads must precede writes, create() fails if the doc exists,
 *     update() fails if it doesn't, and nothing is visible until the transaction commits.
 * It does NOT model contention retries, security rules, or network failures — those are covered by targeted tests.
 */
type Data = Record<string, unknown>;
const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

interface TxCore {
  get(path: string): Data | undefined;
  set(path: string, data: Data, merge?: boolean): void;
  create(path: string, data: Data): void;
  update(path: string, data: Data): void;
  delete(path: string): void;
}

export class FakeStore {
  docs = new Map<string, Data>();
  /** Read accounting for the client-SDK facade: `ops` = round trips (getDoc/getDocs/tx.get), `docs` = documents returned. */
  metrics = { ops: 0, docs: 0, byCollection: {} as Record<string, number>, docsByCollection: {} as Record<string, number> };
  resetMetrics() {
    this.metrics = { ops: 0, docs: 0, byCollection: {}, docsByCollection: {} };
  }
  countRead(collectionPath: string, docs: number) {
    this.metrics.ops += 1;
    this.metrics.docs += docs;
    this.metrics.byCollection[collectionPath] = (this.metrics.byCollection[collectionPath] ?? 0) + 1;
    this.metrics.docsByCollection[collectionPath] = (this.metrics.docsByCollection[collectionPath] ?? 0) + docs;
  }
  private lock: Promise<unknown> = Promise.resolve();
  private autoId = 0;

  reset() {
    this.docs.clear();
    this.autoId = 0;
  }
  newId() {
    return `auto${String(++this.autoId).padStart(4, "0")}`;
  }
  put(path: string, data: Data) {
    this.docs.set(path, clone(data));
  }
  read(path: string): Data | undefined {
    return clone(this.docs.get(path));
  }
  /** Direct children of a collection path, as [id, data]. */
  list(colPath: string): [string, Data][] {
    const prefix = `${colPath}/`;
    const out: [string, Data][] = [];
    for (const [p, d] of this.docs) {
      if (p.startsWith(prefix) && !p.slice(prefix.length).includes("/")) out.push([p.slice(prefix.length), clone(d)]);
    }
    return out.sort((a, b) => a[0].localeCompare(b[0]));
  }
  count(colPath: string) {
    return this.list(colPath).length;
  }

  transact<T>(fn: (tx: TxCore) => Promise<T>): Promise<T> {
    const run = async () => {
      const writes = new Map<string, Data | null>();
      let wrote = false;
      const current = (path: string) => (writes.has(path) ? (writes.get(path) ?? undefined) : this.docs.get(path));
      const tx: TxCore = {
        get: (path) => {
          if (wrote) throw new Error("Firestore transactions require all reads to be executed before all writes");
          return clone(this.docs.get(path));
        },
        set: (path, data, merge) => {
          wrote = true;
          writes.set(path, merge ? { ...(current(path) ?? {}), ...clone(data) } : clone(data));
        },
        create: (path, data) => {
          wrote = true;
          if (current(path)) throw new Error(`ALREADY_EXISTS: ${path}`);
          writes.set(path, clone(data));
        },
        update: (path, data) => {
          wrote = true;
          const cur = current(path);
          if (!cur) throw new Error(`NOT_FOUND: ${path}`);
          writes.set(path, { ...cur, ...clone(data) });
        },
        delete: (path) => {
          wrote = true;
          writes.set(path, null);
        },
      };
      const result = await fn(tx);
      for (const [p, v] of writes) {
        if (v === null) this.docs.delete(p);
        else this.docs.set(p, v);
      }
      return result;
    };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => undefined);
    return p;
  }
}

export const store = new FakeStore();

/* ------------------------------ Admin SDK facade ------------------------------ */

interface Filter {
  field: string;
  op: string;
  value: unknown;
}
const matches = (v: unknown, f: Filter) => {
  switch (f.op) {
    case "==":
      return v === f.value;
    case "in":
      return (f.value as unknown[]).includes(v);
    case "<=":
      return (v as number) <= (f.value as number);
    case "<":
      return (v as number) < (f.value as number);
    case ">=":
      return (v as number) >= (f.value as number);
    case ">":
      return (v as number) > (f.value as number);
    default:
      throw new Error(`fake: unsupported op ${f.op}`);
  }
};

const adminSnap = (path: string, data: Data | undefined) => ({
  id: path.split("/").pop()!,
  ref: adminDocRef(path),
  exists: data !== undefined,
  data: () => clone(data),
});

/** A filter's field is normally a data key; `documentId()` (client string "__name__", or Admin's FieldPath — same toString()) matches the id instead. */
const isDocIdField = (field: unknown) => String(field) === "__name__";
const fieldValue = (id: string, d: Data, field: unknown) => (isDocIdField(field) ? id : d[field as string]);

function adminDocRef(path: string): { id: string; path: string; get(): Promise<ReturnType<typeof adminSnap>>; collection(name: string): unknown } {
  return {
    id: path.split("/").pop()!,
    path,
    get: async () => {
      store.countRead(path.split("/")[0], 1);
      return adminSnap(path, store.read(path));
    },
    collection: (name: string) => adminCollection(`${path}/${name}`),
  };
}

function adminQuery(colPath: string, filters: Filter[] = [], order?: { field: string; dir: "asc" | "desc" }, lim?: number): unknown {
  return {
    where: (field: unknown, op: string, value: unknown) => adminQuery(colPath, [...filters, { field: field as string, op, value }], order, lim),
    orderBy: (field: string, dir: "asc" | "desc" = "asc") => adminQuery(colPath, filters, { field, dir }, lim),
    limit: (n: number) => adminQuery(colPath, filters, order, n),
    get: async () => {
      let rows = store.list(colPath).filter(([id, d]) => filters.every((f) => matches(fieldValue(id, d, f.field), f)));
      if (order) {
        rows = rows.sort((a, b) => {
          const x = a[1][order.field] as number | string;
          const y = b[1][order.field] as number | string;
          return (x < y ? -1 : x > y ? 1 : 0) * (order.dir === "desc" ? -1 : 1);
        });
      }
      if (lim !== undefined) rows = rows.slice(0, lim);
      store.countRead(colPath, rows.length);
      return { docs: rows.map(([id, d]) => adminSnap(`${colPath}/${id}`, d)) };
    },
  };
}

/** `.doc()` with no id auto-generates one — matches real Admin SDK behavior (businessStore.ts relies on this for creates). */
function adminCollection(path: string) {
  return { ...(adminQuery(path) as object), doc: (id?: string) => adminDocRef(`${path}/${id ?? store.newId()}`) };
}

/** Cast to Firestore at the call site; implements just the surface the job engine and businessStore use. */
export function adminFacade() {
  return {
    collection: (path: string) => adminCollection(path),
    runTransaction: <T>(fn: (tx: unknown) => Promise<T>) =>
      store.transact((core) =>
        fn({
          get: async (ref: { path: string }) => {
            store.countRead(ref.path.split("/")[0], 1);
            return adminSnap(ref.path, core.get(ref.path));
          },
          set: (ref: { path: string }, data: Data, opts?: { merge?: boolean }) => core.set(ref.path, data, opts?.merge),
          create: (ref: { path: string }, data: Data) => core.create(ref.path, data),
          update: (ref: { path: string }, data: Data) => core.update(ref.path, data),
          delete: (ref: { path: string }) => core.delete(ref.path),
        })
      ),
  };
}

/* ---------------------------- client SDK module mock ---------------------------- */

class FakeTimestamp {
  constructor(private ms: number) {}
  toMillis() {
    return this.ms;
  }
}

type OrderBy = { field: string; dir: "asc" | "desc" };
type Where = Filter;
type Constraint = OrderBy | Where;
interface ClientRef {
  __col?: boolean;
  path: string;
  id: string;
}
const clientSnap = (path: string, data: Data | undefined) => ({
  id: path.split("/").pop()!,
  exists: () => data !== undefined,
  data: () => clone(data),
});

/** Drop-in for `vi.mock("firebase/firestore")` — only what src/lib/store.ts uses. */
export const clientModule = {
  Timestamp: FakeTimestamp,
  collection: (_db: unknown, name: string): ClientRef => ({ __col: true, path: name, id: name }),
  doc: (a: unknown, ...rest: string[]): ClientRef => {
    const first = a as ClientRef;
    if (first && first.__col) {
      const id = rest[0] ?? store.newId();
      return { path: `${first.path}/${id}`, id };
    }
    const path = rest.join("/");
    return { path, id: rest[rest.length - 1] };
  },
  query: (col: ClientRef, ...constraints: unknown[]) => ({ col, constraints }),
  orderBy: (field: string, dir: "asc" | "desc" = "asc"): OrderBy => ({ field, dir }),
  where: (field: string, op: string, value: unknown): Where => ({ field, op, value }),
  documentId: () => "__name__",
  getDoc: async (ref: ClientRef) => {
    store.countRead(ref.path.split("/")[0], 1);
    return clientSnap(ref.path, store.read(ref.path));
  },
  getDocs: async (q: ClientRef | { col: ClientRef; constraints: Constraint[] }) => {
    const col = "col" in q ? q.col : q;
    let rows = store.list(col.path);
    const constraints = "col" in q ? q.constraints : [];
    for (const c of constraints) if ("op" in c) rows = rows.filter(([id, d]) => matches(c.field === "__name__" ? id : d[c.field], c));
    const ord = constraints.find((c): c is OrderBy => "dir" in c);
    if (ord) {
      rows = rows.sort((a, b) => {
        const x = a[1][ord.field] as number | string;
        const y = b[1][ord.field] as number | string;
        return (x < y ? -1 : x > y ? 1 : 0) * (ord.dir === "desc" ? -1 : 1);
      });
    }
    store.countRead(col.path, rows.length);
    return { docs: rows.map(([id, d]) => clientSnap(`${col.path}/${id}`, d)) };
  },
  addDoc: async (col: ClientRef, data: Data) => {
    const id = store.newId();
    store.put(`${col.path}/${id}`, data);
    return { id, path: `${col.path}/${id}` };
  },
  updateDoc: async (ref: ClientRef, data: Data) =>
    store.transact(async (tx) => {
      tx.update(ref.path, data);
    }),
  deleteDoc: async (ref: ClientRef) =>
    store.transact(async (tx) => {
      tx.delete(ref.path);
    }),
  onSnapshot: () => {
    throw new Error("fake: onSnapshot not supported");
  },
  runTransaction: <T>(_db: unknown, fn: (tx: unknown) => Promise<T>) =>
    store.transact((core) =>
      fn({
        get: async (ref: ClientRef) => {
          store.countRead(ref.path.split("/")[0], 1);
          return clientSnap(ref.path, core.get(ref.path));
        },
        set: (ref: ClientRef, data: Data, opts?: { merge?: boolean }) => core.set(ref.path, data, opts?.merge),
        update: (ref: ClientRef, data: Data) => core.update(ref.path, data),
      })
    ),
};

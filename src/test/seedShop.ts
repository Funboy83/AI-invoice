import { store } from "./fakeFirestore";

/** Deterministic PRNG so fixtures (and therefore measurements) are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const BRANDS = ["Milo", "Nescafe", "Vinamilk", "Omo", "Comfort", "Lipton", "Oishi", "Knorr", "Maggi", "Hao Hao", "Coca", "Pepsi", "Sunlight", "Lifebuoy", "Colgate", "Dove", "Tiger", "Heineken", "Aquafina", "Vissan"];
const KINDS = ["hộp lớn", "gói nhỏ", "chai 1L", "lon 330ml", "bịch 500g", "thùng 24", "túi 1kg", "lốc 6", "bao 5kg", "can 2L"];

export interface ShopFixture {
  focusCustomerId: string;
  /** Distinct product names (all resolve to exactly one product with score 1.0). */
  productNames: string[];
  productIds: string[];
}

/** Realistic-size shop: `products` catalog, `customers` customers, `invoicesPerCustomer` invoices each. */
export function seedShop(opts: { products?: number; customers?: number; invoicesPerCustomer?: number; focusInvoices?: number } = {}): ShopFixture {
  const { products = 200, customers = 40, invoicesPerCustomer = 12, focusInvoices = 25 } = opts;
  const rand = rng(42);
  const now = 1_700_000_000_000;

  const productIds: string[] = [];
  const productNames: string[] = [];
  for (let i = 0; i < products; i++) {
    const name = `${BRANDS[i % BRANDS.length]} ${KINDS[Math.floor(i / BRANDS.length) % KINDS.length]}`;
    const id = `p${String(i).padStart(3, "0")}`;
    productIds.push(id);
    productNames.push(name);
    store.put(`products/${id}`, {
      name,
      aliases: [],
      defaultUnit: "thùng",
      defaultPrice: 10 + (i % 17),
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  const focusCustomerId = "c0";
  for (let c = 0; c < customers; c++) {
    const id = `c${c}`;
    store.put(`customers/${id}`, {
      name: c === 0 ? "Hoa Lee" : `Khách hàng số ${c} ${BRANDS[c % BRANDS.length]}`,
      aliases: [],
      active: true,
      defaultShipping: 0,
      createdAt: now,
      updatedAt: now,
    });
    const count = c === 0 ? focusInvoices : invoicesPerCustomer;
    for (let k = 0; k < count; k++) {
      const lines = Array.from({ length: 3 }, () => {
        const pi = Math.floor(rand() * products);
        const price = 12 + Math.floor(rand() * 20);
        const quantity = 1 + Math.floor(rand() * 10);
        return { productId: productIds[pi], productName: productNames[pi], quantity, unit: "thùng", price, lineTotal: price * quantity };
      });
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      const createdAt = now + (c * 1000 + k) * 3_600_000;
      store.put(`invoices/inv-${c}-${k}`, {
        invoiceNumber: String(1000 + c * 100 + k),
        date: createdAt,
        customerId: id,
        customerName: c === 0 ? "Hoa Lee" : `Khách hàng số ${c}`,
        items: lines,
        shipping: 0,
        discount: 0,
        subtotal,
        total: subtotal,
        amountPaid: 0,
        balance: subtotal,
        paymentStatus: k % 7 === 0 ? "void" : "unpaid",
        createdAt,
        updatedAt: createdAt,
        createdBy: "user",
      });
    }
  }
  return { focusCustomerId, productNames, productIds };
}

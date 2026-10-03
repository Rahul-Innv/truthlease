/**
 * Private seller policies, keyed by merchant id. SERVER ONLY.
 *
 * Nothing under src/components, src/hooks or src/app/(page|layout|dev) may import
 * this module or `catalog.ts`; the public profile lives in `catalog-public.ts`.
 */
import { Merchant, MerchantPublic, SellerPolicy, type Merchant as MerchantT, type MerchantPublic as MerchantPublicT, type SellerPolicy as SellerPolicyT } from "./contracts";
import { DEMO_VENUE, PUBLIC_CATALOG } from "./catalog-public";

export { DEMO_VENUE, PUBLIC_CATALOG };

const POLICIES: Record<string, SellerPolicyT> = {
  "m-juniper": SellerPolicy.parse({ floorPctOfList: 90, volumeDiscount: [{ minQty: 50, pct: 8 }], slotFlexible: true, maxRounds: 2 }),
  "m-goldenhour": SellerPolicy.parse({ floorPctOfList: 94, volumeDiscount: [{ minQty: 60, pct: 5 }], slotFlexible: true, maxRounds: 2 }),
  "m-harbor": SellerPolicy.parse({ floorPctOfList: 92, volumeDiscount: [{ minQty: 80, pct: 6 }], slotFlexible: true, maxRounds: 2 }),
  "m-fogline": SellerPolicy.parse({ floorPctOfList: 90, volumeDiscount: [{ minQty: 80, pct: 5 }], slotFlexible: true, maxRounds: 2 }),
  "m-bodega": SellerPolicy.parse({ floorPctOfList: 100, volumeDiscount: [], slotFlexible: false, maxRounds: 1 }),
  "m-pelican": SellerPolicy.parse({ floorPctOfList: 100, volumeDiscount: [], slotFlexible: true, maxRounds: 2 }),
  "m-swiftline": SellerPolicy.parse({ floorPctOfList: 100, volumeDiscount: [], slotFlexible: false, maxRounds: 1 }),
};

/** Validated private catalog (server only). */
export const CATALOG: MerchantT[] = PUBLIC_CATALOG.map((m) => {
  const policy = POLICIES[m.id];
  if (!policy) throw new Error(`Missing seller policy for ${m.id}`);
  return Merchant.parse({ ...m, policy });
});

export function getMerchant(id: string): MerchantT | undefined {
  return CATALOG.find((m) => m.id === id);
}

/** Strip private policy before anything leaves the server's seller context. */
export function toPublic(m: MerchantT): MerchantPublicT {
  const { policy: _policy, ...rest } = m;
  void _policy;
  return MerchantPublic.parse(rest);
}

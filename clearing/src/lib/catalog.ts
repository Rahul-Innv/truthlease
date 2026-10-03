/**
 * Fictional demo merchant catalog.
 *
 * Every merchant here is invented for the demo. Prices, capacities, lead
 * times, slots and cancellation terms are modelled inputs, not real-world
 * guarantees. The `policy` block is private seller state and is stripped
 * before anything reaches the buyer, the UI, or a model prompt for a buyer.
 */
import { Merchant, MerchantPublic, type Merchant as MerchantT, type MerchantPublic as MerchantPublicT } from "./contracts";

export const DEMO_VENUE = {
  name: "Pier 9 Workshop Hall (fictional demo venue)",
  zone: "bayfront",
  fictional: true as const,
};

const raw: MerchantT[] = [
  {
    id: "m-juniper",
    name: "Juniper & Rye Catering",
    tagline: "Boxed dinners, delivered and set up",
    group: "meals",
    fictional: true,
    provenance: "demo_catalog",
    serviceZones: ["bayfront", "mission", "soma"],
    capacity: { maxMeals: 90 },
    minMeals: 30,
    fulfillment: {
      mode: "included_delivery",
      deliveryFeeCents: 4000,
      slots: [
        { id: "arr-1745", label: "Arrive 5:45 PM", timeLocal: "17:45" },
        { id: "arr-1800", label: "Arrive 6:00 PM", timeLocal: "18:00" },
      ],
      defaultSlotId: "arr-1745",
    },
    serviceFeePct: 5,
    leadTimeMinutes: 180,
    catalog: [
      { sku: "veg-bowl", label: "Roasted vegetable grain bowl (vegetarian)", kind: "meal_vegetarian", unitCents: 1250, minQty: 0, maxQty: 90 },
      { sku: "std-box", label: "Herb chicken dinner box", kind: "meal_standard", unitCents: 1350, minQty: 0, maxQty: 90 },
    ],
    cancellation: { refundablePct: 100, settlement: "immediate", note: "Free cancellation; simulated refund settles immediately." },
    description: "Family-run demo caterer. Boxed dinners arrive labelled by dietary type.",
    policy: { floorPctOfList: 90, volumeDiscount: [{ minQty: 50, pct: 8 }], slotFlexible: true, maxRounds: 2 },
  },
  {
    id: "m-goldenhour",
    name: "Golden Hour Taqueria",
    tagline: "Taco plates for pickup",
    group: "meals",
    fictional: true,
    provenance: "demo_catalog",
    serviceZones: ["bayfront", "mission"],
    capacity: { maxMeals: 70 },
    minMeals: 20,
    fulfillment: {
      mode: "pickup_only",
      slots: [
        { id: "ready-1730", label: "Ready 5:30 PM", timeLocal: "17:30" },
        { id: "ready-1700", label: "Ready 5:00 PM", timeLocal: "17:00" },
      ],
      defaultSlotId: "ready-1730",
    },
    serviceFeePct: 0,
    leadTimeMinutes: 120,
    catalog: [
      { sku: "veg-plate", label: "Black bean & squash taco plate (vegetarian)", kind: "meal_vegetarian", unitCents: 925, minQty: 0, maxQty: 70 },
      { sku: "std-plate", label: "Carnitas taco plate", kind: "meal_standard", unitCents: 1025, minQty: 0, maxQty: 70 },
    ],
    cancellation: { refundablePct: 100, settlement: "immediate", note: "Free cancellation; simulated refund settles immediately." },
    description: "Counter-service demo taqueria. Pickup only; a courier is required for venue delivery.",
    policy: { floorPctOfList: 94, volumeDiscount: [{ minQty: 60, pct: 5 }], slotFlexible: true, maxRounds: 2 },
  },
  {
    id: "m-harbor",
    name: "Harbor Kitchen Collective",
    tagline: "Large-format catering, delivery included",
    group: "meals",
    fictional: true,
    provenance: "demo_catalog",
    serviceZones: ["bayfront", "soma"],
    capacity: { maxMeals: 120 },
    minMeals: 75,
    fulfillment: {
      mode: "included_delivery",
      deliveryFeeCents: 0,
      slots: [
        { id: "arr-1800", label: "Arrive 6:00 PM", timeLocal: "18:00" },
        { id: "arr-1730", label: "Arrive 5:30 PM", timeLocal: "17:30" },
      ],
      defaultSlotId: "arr-1800",
    },
    serviceFeePct: 8,
    leadTimeMinutes: 200,
    catalog: [
      { sku: "veg-tray", label: "Paneer & chickpea curry plate (vegetarian)", kind: "meal_vegetarian", unitCents: 995, minQty: 0, maxQty: 120 },
      { sku: "std-tray", label: "Lemon herb chicken plate", kind: "meal_standard", unitCents: 1045, minQty: 0, maxQty: 120 },
    ],
    cancellation: { refundablePct: 80, settlement: "pending", note: "20% retained on cancellation; simulated refund of the rest is pending until settled." },
    description: "Demo collective kitchen for 75+ guests. Delivery included in the quoted price.",
    policy: { floorPctOfList: 92, volumeDiscount: [{ minQty: 80, pct: 6 }], slotFlexible: true, maxRounds: 2 },
  },
  {
    id: "m-fogline",
    name: "Fogline Beverage Co.",
    tagline: "Drinks, plates and utensils, delivered",
    group: "drinks_consumables",
    fictional: true,
    provenance: "demo_catalog",
    serviceZones: ["bayfront", "mission", "soma"],
    capacity: { maxDrinkServings: 200 },
    fulfillment: {
      mode: "included_delivery",
      deliveryFeeCents: 2500,
      slots: [
        { id: "arr-1815", label: "Arrive 6:15 PM", timeLocal: "18:15" },
        { id: "arr-1630", label: "Arrive 4:30 PM", timeLocal: "16:30" },
      ],
      defaultSlotId: "arr-1815",
    },
    serviceFeePct: 0,
    leadTimeMinutes: 90,
    catalog: [
      { sku: "drink", label: "Sparkling water & soft drink service (nonalcoholic)", kind: "drink_serving", unitCents: 210, minQty: 40, maxQty: 200 },
      { sku: "plate", label: "Compostable plate", kind: "plate", unitCents: 45, minQty: 0, maxQty: 400 },
      { sku: "utensils", label: "Utensil set", kind: "utensil_set", unitCents: 35, minQty: 0, maxQty: 400 },
    ],
    cancellation: { refundablePct: 100, settlement: "pending", note: "Full simulated refund, pending until settled." },
    description: "Demo beverage distributor. Minimum 40 drink servings per order.",
    policy: { floorPctOfList: 90, volumeDiscount: [{ minQty: 80, pct: 5 }], slotFlexible: true, maxRounds: 2 },
  },
  {
    id: "m-bodega",
    name: "Bodega Marquez",
    tagline: "Corner-store drinks and party supplies, pickup",
    group: "drinks_consumables",
    fictional: true,
    provenance: "demo_catalog",
    serviceZones: ["bayfront"],
    capacity: { maxDrinkServings: 150 },
    fulfillment: {
      mode: "pickup_only",
      slots: [{ id: "ready-1600", label: "Ready 4:00 PM", timeLocal: "16:00" }],
      defaultSlotId: "ready-1600",
    },
    serviceFeePct: 0,
    leadTimeMinutes: 60,
    catalog: [
      { sku: "drink", label: "Assorted canned soft drinks & water (nonalcoholic)", kind: "drink_serving", unitCents: 175, minQty: 0, maxQty: 150 },
      { sku: "plate", label: "Paper plate", kind: "plate", unitCents: 40, minQty: 0, maxQty: 300 },
      { sku: "utensils", label: "Utensil set", kind: "utensil_set", unitCents: 30, minQty: 0, maxQty: 300 },
    ],
    cancellation: { refundablePct: 100, settlement: "immediate", note: "Free cancellation; simulated refund settles immediately." },
    description: "Demo corner store. Fixed prices, pickup only.",
    policy: { floorPctOfList: 100, volumeDiscount: [], slotFlexible: false, maxRounds: 1 },
  },
  {
    id: "m-pelican",
    name: "Pelican Couriers",
    tagline: "Two-stop event runs",
    group: "delivery",
    fictional: true,
    provenance: "demo_catalog",
    serviceZones: ["bayfront", "mission", "soma"],
    capacity: { maxPickups: 2 },
    fulfillment: {
      mode: "courier",
      slots: [
        { id: "run-1750", label: "Arrive 5:50 PM (pickups by 5:15 PM)", timeLocal: "17:50", pickupByLocal: "17:15" },
        { id: "run-1805", label: "Arrive 6:05 PM (pickups by 5:30 PM)", timeLocal: "18:05", pickupByLocal: "17:30" },
      ],
      defaultSlotId: "run-1750",
    },
    serviceFeePct: 0,
    leadTimeMinutes: 60,
    catalog: [{ sku: "route-2", label: "Event run, up to 2 pickups", kind: "delivery_run", unitCents: 7200, minQty: 1, maxQty: 1 }],
    cancellation: { refundablePct: 100, settlement: "immediate", note: "Free cancellation; simulated refund settles immediately." },
    description: "Demo courier. One vehicle, up to two pickup stops, one venue drop.",
    policy: { floorPctOfList: 100, volumeDiscount: [], slotFlexible: true, maxRounds: 2 },
  },
  {
    id: "m-swiftline",
    name: "Swiftline Runners",
    tagline: "Single-stop runs",
    group: "delivery",
    fictional: true,
    provenance: "demo_catalog",
    serviceZones: ["bayfront", "soma"],
    capacity: { maxPickups: 1 },
    fulfillment: {
      mode: "courier",
      slots: [{ id: "run-1800", label: "Arrive 6:00 PM (pickup by 5:30 PM)", timeLocal: "18:00", pickupByLocal: "17:30" }],
      defaultSlotId: "run-1800",
    },
    serviceFeePct: 0,
    leadTimeMinutes: 45,
    catalog: [{ sku: "route-1", label: "Event run, 1 pickup", kind: "delivery_run", unitCents: 4400, minQty: 1, maxQty: 1 }],
    cancellation: { refundablePct: 100, settlement: "immediate", note: "Free cancellation; simulated refund settles immediately." },
    description: "Demo courier. Single pickup, single drop.",
    policy: { floorPctOfList: 100, volumeDiscount: [], slotFlexible: false, maxRounds: 1 },
  },
];

/** Validated private catalog (server only). */
export const CATALOG: MerchantT[] = raw.map((m) => Merchant.parse(m));

export function getMerchant(id: string): MerchantT | undefined {
  return CATALOG.find((m) => m.id === id);
}

/** Strip private policy before anything leaves the server's seller context. */
export function toPublic(m: MerchantT): MerchantPublicT {
  const { policy: _policy, ...rest } = m;
  void _policy;
  return MerchantPublic.parse(rest);
}

export const PUBLIC_CATALOG: MerchantPublicT[] = CATALOG.map(toPublic);

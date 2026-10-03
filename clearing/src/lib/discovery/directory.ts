/**
 * FICTIONAL supplier directory used for discovery.
 *
 * 18 entries: the 7 executable demo-catalog merchants (same ids and names as
 * `catalog-public.ts`, searchable text built from their public profile) plus 11
 * clearly fictional suppliers that have no authorized offer or policy in the
 * demo catalog. Those 11 are display-only: they can appear as discovered
 * candidates but can never quote, negotiate, or be cleared.
 *
 * Nothing here is a real business. Descriptions are untrusted data once they
 * round-trip through a search engine, so consumers must look entries up by id
 * in THIS module rather than trusting text or metadata that comes back.
 */
import { PUBLIC_CATALOG } from "../catalog-public";
import type { MerchantPublic } from "../contracts";

export interface DirectoryEntry {
  id: string;
  name: string;
  /** Searchable description (this is the text that gets embedded / matched). */
  text: string;
  /** Flat string map: this is the shape Moss stores per document. */
  metadata: { group: string; zones: string; executable: "true" | "false"; name: string };
  executable: boolean;
  /** Present on every non-executable entry. */
  why_not_executable?: string;
}

export const NOT_EXECUTABLE_NOTE = "no authorized offer or policy in the demo catalog";

const GROUP_WORDS: Record<string, string> = {
  meals: "catering meals dinner food",
  drinks_consumables: "drinks beverages plates utensils consumables supplies",
  delivery: "courier delivery logistics runs",
};

const FULFILLMENT_WORDS: Record<string, string> = {
  included_delivery: "Delivery included in the quoted price.",
  pickup_only: "Pickup only; a courier is needed for delivery.",
  courier: "Courier service: pickup stops and a venue drop.",
};

function capacityText(m: MerchantPublic): string {
  const c = m.capacity;
  const parts: string[] = [];
  if (c.maxMeals !== undefined) parts.push(`up to ${c.maxMeals} meals`);
  if (c.maxDrinkServings !== undefined) parts.push(`up to ${c.maxDrinkServings} drink servings`);
  if (c.maxPickups !== undefined) parts.push(`up to ${c.maxPickups} pickup stops`);
  if (m.minMeals !== undefined) parts.push(`minimum order ${m.minMeals} meals`);
  return parts.length ? `Capacity ${parts.join(", ")}.` : "";
}

function executableEntry(m: MerchantPublic): DirectoryEntry {
  const items = m.catalog.map((i) => i.label).join("; ");
  const text = [
    `${m.name}: ${m.tagline}.`,
    `${GROUP_WORDS[m.group] ?? m.group}.`,
    `Serves ${m.serviceZones.join(", ")} zones.`,
    FULFILLMENT_WORDS[m.fulfillment.mode] ?? "",
    `Items: ${items}.`,
    capacityText(m),
  ]
    .filter(Boolean)
    .join(" ");
  return {
    id: m.id,
    name: m.name,
    text,
    metadata: { group: m.group, zones: m.serviceZones.join(","), executable: "true", name: m.name },
    executable: true,
  };
}

function other(id: string, name: string, group: string, zones: string[], text: string, why = NOT_EXECUTABLE_NOTE): DirectoryEntry {
  return {
    id,
    name,
    text: `${name}: ${text} Serves ${zones.join(", ")} zones.`,
    metadata: { group, zones: zones.join(","), executable: "false", name },
    executable: false,
    why_not_executable: why,
  };
}

const NON_EXECUTABLE: DirectoryEntry[] = [
  other("d-bagels", "Bay Bagels", "meals", ["bayfront", "soma"], "breakfast pastries, bagels and coffee boxes, morning orders only."),
  other("d-sierra-sound", "Sierra Sound Rentals", "av_equipment", ["bayfront", "mission", "soma"], "audio and AV equipment rental: speakers, microphones, projectors and stage lighting."),
  other("d-mission-tamales", "Mission Tamales", "meals", ["mission"], "tamales and lunch plates, lunch service, Mission zone only."),
  other("d-nightjar", "Nightjar Bar Service", "alcohol", ["bayfront", "mission"], "licensed bartenders, cocktails, beer and wine service.", "alcohol is out of scope for this demo; no authorized offer or policy"),
  other("d-pacific-bento", "Pacific Bento Co.", "meals", ["soma", "bayfront"], "bento lunch boxes, minimum order 150 boxes, lunch only."),
  other("d-golden-gate-ice", "Golden Gate Ice", "drinks_consumables", ["bayfront", "soma"], "bagged and block ice delivery for coolers and events."),
  other("d-foghorn-photo", "Foghorn Photo Booth", "entertainment", ["bayfront", "mission", "soma"], "photo booth rental with prints, props and an attendant."),
  other("d-cable-car-tents", "Cable Car Tents and Tables", "event_rentals", ["bayfront", "soma"], "tent, folding table and chair rental with setup crew."),
  other("d-dolores-desserts", "Dolores Desserts", "meals", ["mission"], "cupcakes, cookies and dessert trays; custom cakes need three days notice."),
  other("d-redwood-compost", "Redwood Compost Hauling", "services", ["bayfront", "mission", "soma"], "event waste, recycling and compost hauling after the event."),
  other("d-ferry-ride", "Ferry Building Rideshare Shuttles", "transport", ["bayfront", "soma"], "passenger shuttle vans for attendee transport; people only, no goods delivery."),
];

/** The searchable directory: executable catalog merchants first, then display-only suppliers. */
export const DIRECTORY: DirectoryEntry[] = [...PUBLIC_CATALOG.map(executableEntry), ...NON_EXECUTABLE];

const BY_ID = new Map(DIRECTORY.map((e) => [e.id, e]));

export function getDirectoryEntry(id: string): DirectoryEntry | undefined {
  return BY_ID.get(id);
}

/** The note shown for a candidate, derived only from the local directory entry. */
export function candidateNote(e: DirectoryEntry): string {
  return e.executable ? "executable demo-catalog merchant" : e.why_not_executable ?? NOT_EXECUTABLE_NOTE;
}

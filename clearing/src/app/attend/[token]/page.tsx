import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getService } from "@/lib/app";
import type { AttendeePublicView } from "@/lib/attendee";
import { NotFound } from "@/lib/service";
import { AttendeeForm } from "./AttendeeForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Meal preference · Clearing",
  description: "Tell the organizer your meal preference. Not an order, a reservation, or a payment.",
  // The token in the URL is a credential: never send it onward, never index the page.
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

/**
 * Public attendee page (P1). Reads only the public view for the link token:
 * no budget, plan, offers, run id or organizer controls reach this page.
 */
export default async function AttendPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const service = await getService();
  let view: AttendeePublicView;
  try {
    view = service.getAttendeeView(token);
  } catch (err) {
    if (err instanceof NotFound) notFound();
    throw err;
  }
  return <AttendeeForm token={token} initial={view} />;
}

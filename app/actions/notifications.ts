"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth-helpers";
import { expireTag, TAGS } from "@/lib/cache-tags";
import { currentOrganisationIdFor, notificationInOrganisation } from "@/lib/organisation-context";
import { notificationTrackWhere } from "@/lib/my-work-filter";
import type { WorkTrack } from "@prisma/client";

/** Marks all of the current user's notifications as read (#216). */
export async function markAllNotificationsReadAction(
  allOrganisations = false,
  track: WorkTrack | "all" = "all",
): Promise<{ ok: boolean }> {
  const user = await requireUser();
  const organisationId = allOrganisations ? null : await currentOrganisationIdFor(user.id);
  await prisma.notification.updateMany({
    where: {
      userId: user.id,
      readAt: null,
      AND: [notificationInOrganisation(organisationId, allOrganisations), notificationTrackWhere(track)],
    },
    data: { readAt: new Date() },
  });
  expireTag(TAGS.unread(user.id));
  revalidatePath("/", "layout");
  return { ok: true };
}

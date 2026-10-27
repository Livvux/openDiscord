import { notFound } from "next/navigation";
import { cache } from "react";
import { getCommunityView, listCommunityNavigation } from "./communities";
import { AppError } from "./errors";

/** For pages: turns "not found"/"forbidden" service errors into the 404 page (no existence leaks). */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof AppError && (error.code === "not_found" || error.code === "forbidden" || error.code === "invalid")) {
      notFound();
    }
    throw error;
  }
}

/** Deduplicates the community lookup between a layout and its page within one request. */
export const loadCommunityView = cache(async (userId: string, communityId: string) =>
  orNotFound(getCommunityView(userId, communityId)),
);

/** The rail and the title bar both list the person's communities. */
export const loadCommunityNavigation = cache((userId: string) => listCommunityNavigation(userId));

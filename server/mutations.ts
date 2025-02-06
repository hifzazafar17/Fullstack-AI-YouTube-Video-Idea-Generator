"use server";

import { auth } from "@clerk/nextjs/server";
import { YouTubeChannels, YouTubeChannelType } from "./db/schema";
import { db } from "./db/drizzle";
import { and, eq } from "drizzle-orm";

export const addChannelForUser = async (
  name: string
): Promise<YouTubeChannelType> => {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("User not authenticated");
  }

  const [newChannel] = await db
    .insert(YouTubeChannels)
    .values({
      name,
      userId,
    })
    .returning();

  return newChannel;
};

export const removeChannelForUser = async (id: string): Promise<void> => {
  const { userId } = await auth();

  if (!userId) {
    throw new Error("User not authenticated");
  }

  await db
    .delete(YouTubeChannels)
    .where(and(eq(YouTubeChannels.id, id), eq(YouTubeChannels.userId, userId)));
};
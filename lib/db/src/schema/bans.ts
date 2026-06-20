import { pgTable, text, serial, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { roomsTable } from "./rooms";

export const bansTable = pgTable("bans", {
  id: serial("id").primaryKey(),
  roomId: integer("room_id").notNull().references(() => roomsTable.id),
  ip: text("ip").notNull(),
  bannedBy: text("banned_by"),
  bannedAt: timestamp("banned_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  roomIpIdx: index("bans_room_ip_idx").on(table.roomId, table.ip),
}));

export const insertBanSchema = createInsertSchema(bansTable).omit({ id: true, bannedAt: true });
export type InsertBan = z.infer<typeof insertBanSchema>;
export type Ban = typeof bansTable.$inferSelect;

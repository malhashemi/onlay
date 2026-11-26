import * as z from "zod/mini";

/** A string schema capped at `max` UTF-16 code units. */
export const bounded = (max: number) => z.string().check(z.maxLength(max));

/** A non-negative number schema (counters, sequence numbers). */
export const count = () => z.number().check(z.gte(0));

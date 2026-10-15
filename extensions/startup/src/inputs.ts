import { createHash } from "node:crypto";
import { z } from "zod";
import { encode, jsonSchema, StoreAuthorityError, type Json } from "./contracts";

export const rawInputSchema = z.object({
  text: z.string(),
  images: z.array(jsonSchema),
});
export const imageSchema = z.object({
  type: z.literal("image"),
  data: z.string().min(1),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
});
export function inputSummary(inputId: string, raw: Json) {
  const parsed = rawInputSchema.safeParse(raw);
  const text = parsed.success
    ? parsed.data.text
    : typeof raw === "string"
      ? raw
      : encode(raw);
  const images = parsed.success ? parsed.data.images : [];
  return {
    inputId,
    textPreview: text.slice(0, 512),
    textLength: text.length,
    attachmentCount: images.length,
    attachments: images.slice(0, 8).map((raw, index) => {
      const image = imageSchema.parse(raw);
      return {
        inputId,
        index,
        mimeType: image.mimeType,
        bytes: Buffer.from(image.data, "base64").length,
        sha256: createHash("sha256").update(image.data).digest("hex"),
        tool: "startup_image",
      };
    }),
    textTool: "startup_input",
  };
}

export function inputPage(input: Readonly<{ inputId: string; raw: Json; offset: number }>) {
  const parsed = rawInputSchema.safeParse(input.raw);
  const text = parsed.success ? parsed.data.text : typeof input.raw === "string" ? input.raw : encode(input.raw);
  if (input.offset > text.length) throw new StoreAuthorityError("Input offset exceeds stored text length");
  return { ...inputSummary(input.inputId, input.raw), offset: input.offset, text: text.slice(input.offset, input.offset + 4096), nextOffset: input.offset + 4096 < text.length ? input.offset + 4096 : null };
}

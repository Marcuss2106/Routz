import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

const candidateFiles = [
  "train.wav",
  "130090__mr-tea__train-at-ford-plant-1.wav",
];

export async function GET() {
  for (const filename of candidateFiles) {
    const filePath = path.join(process.cwd(), "..", filename);
    try {
      await access(filePath);
      const audio = await readFile(filePath);
      return new NextResponse(audio, {
        headers: {
          "Cache-Control": "public, max-age=3600",
          "Content-Length": String(audio.byteLength),
          "Content-Type": "audio/wav",
        },
      });
    } catch {
      // Try the next repository-compatible filename.
    }
  }

  return NextResponse.json(
    { error: "No train.wav source file is available." },
    { status: 404 },
  );
}

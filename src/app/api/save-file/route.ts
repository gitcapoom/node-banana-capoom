import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs/promises";
import * as path from "path";
import { validateWorkflowPath } from "@/utils/pathValidation";

/**
 * POST: Save a JSON file to disk.
 * Body: { directoryPath: string, filename: string, content: object, createDirectory?: boolean }
 */
export async function POST(request: NextRequest) {
  try {
    const { directoryPath, filename, content, createDirectory } = await request.json();

    if (!directoryPath || !filename || content === undefined) {
      return NextResponse.json(
        { success: false, error: "directoryPath, filename, and content are required" },
        { status: 400 }
      );
    }

    // Validate path
    const pathValidation = validateWorkflowPath(directoryPath);
    if (!pathValidation.valid) {
      return NextResponse.json(
        { success: false, error: pathValidation.error },
        { status: 400 }
      );
    }

    // Sanitize filename
    const sanitizedFilename = filename.replace(/[<>:"|?*]/g, "_");
    const extension = sanitizedFilename.endsWith(".json") ? "" : ".json";
    const fullFilename = `${sanitizedFilename}${extension}`;
    const filePath = path.join(directoryPath, fullFilename);

    // Create directory if requested
    if (createDirectory) {
      await fs.mkdir(directoryPath, { recursive: true });
    }

    // Write the file
    const jsonString = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    await fs.writeFile(filePath, jsonString, "utf-8");

    return NextResponse.json({
      success: true,
      filePath,
      filename: fullFilename,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    return NextResponse.json(
      { success: false, error: err.message || "Failed to save file" },
      { status: 500 }
    );
  }
}

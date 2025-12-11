import * as logger from "firebase-functions/logger";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { initializeApp } from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";
import { getFirestore } from "firebase-admin/firestore";
import fetch from "node-fetch";

initializeApp();

interface GenerateImagesRequest {
  uid: string;
  uploadId: string;
  forTesting: boolean;
}

export const generateImages = onCall<GenerateImagesRequest>(
  { memory: "2GiB", timeoutSeconds: 540, secrets: ["GEMINI_API_KEY"] },
  async (request) => {
    try {
      // 1. Auth check
      if (!request.auth || !request.auth.uid) {
        throw new HttpsError("unauthenticated", "User must be authenticated.");
      }

      const authUid = request.auth.uid;
      const { uid, uploadId, forTesting } = request.data || {};

      // 2. Validasi input basic
      if (!uid || !uploadId) {
        throw new HttpsError("invalid-argument", "uid and uploadId are required.");
      }
      if (uid !== authUid) {
        throw new HttpsError("permission-denied", "Cannot generate for another user.");
      }

      const count = forTesting ? 1 : 4;
      const finalPrompt =
        "Transform this portrait into a realistic Instagram travel/lifestyle photo. High quality, natural lighting, professional photography style.";

      // 3. API key (set via: firebase functions:secrets:set GEMINI_API_KEY)
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        logger.error("GEMINI_API_KEY not set");
        throw new HttpsError("failed-precondition", "AI service not configured.");
      }

      // 4. Ambil original image dari Storage: users/{uid}/original/{uploadId}.jpg
      const bucket = getStorage().bucket();
      const originalFilePath = `users/${uid}/original/${uploadId}.jpg`;
      const originalFile = bucket.file(originalFilePath);

      const [exists] = await originalFile.exists();
      if (!exists) {
        throw new HttpsError(
          "not-found",
          "Original image not found for given uploadId."
        );
      }

      const [originalBuffer] = await originalFile.download();
      const originalDownloadUrl = originalFile.publicUrl();

      // 5. Panggil Gemini 2.5 Flash Image (Nano Banana) via REST
      const modelName = "gemini-2.5-flash-image";
      const apiVersion = "v1beta";

      const geminiPayload = {
        contents: [
          {
            parts: [
              {
                text: `Generate ${count} different high-quality Instagram-ready travel/lifestyle photos using this portrait as the main subject. Each photo should place the person in a different realistic scene (beach, city, mountains, cafe, road trip, etc.). Keep the person's face, pose, and clothing consistent but change the background and lighting naturally. Professional photography quality.\n\n${finalPrompt}`,
              },
              {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: originalBuffer.toString("base64"),
                },
              },
            ],
          },
        ],
      };

      const aiResponse = await fetch(
        `https://generativelanguage.googleapis.com/${apiVersion}/models/${modelName}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(geminiPayload),
        }
      );

      if (!aiResponse.ok) {
        const errorText = await aiResponse.text();
        logger.error("Gemini API error", {
          status: aiResponse.status,
          error: errorText,
        });

        if (aiResponse.status === 503) {
          throw new HttpsError(
            "unavailable",
            "AI model is overloaded. Please try again in a moment."
          );
        }

        if (aiResponse.status === 429) {
          throw new HttpsError(
            "resource-exhausted",
            "AI quota exceeded. Please try again later."
          );
        }

        throw new HttpsError(
          "internal",
          "AI generation failed. Please try again."
        );
      }

      const aiResult = (await aiResponse.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              inlineData?: { data: string };
              [key: string]: any;
            }>;
          };
        }>;
      };

      // 6. Simpan generated images ke Storage: users/{uid}/generated/{uploadId}_{i}.png
      logger.info('Gemini response received.');
      logger.info("Gemini raw result", aiResult);

      const candidates = aiResult.candidates ?? [];
      const generatedImages: Array<string> = [];

      for (const candidate of candidates) {
        const parts = candidate.content?.parts ?? [];
        for (const part of parts) {
          const data = part.inlineData?.data;
          if (!data) continue;

          const index = generatedImages.length + 1;
          const imgBuffer = Buffer.from(data, "base64");
          const genFilePath = `users/${uid}/generated/${uploadId}_${index}.png`;
          const genFile = bucket.file(genFilePath);

          await genFile.save(imgBuffer, {
            contentType: "image/png",
            metadata: {
              metadata: {
                ownerUid: uid,
                type: "generated",
                original: originalFilePath,
              },
            },
          });
          generatedImages.push(genFilePath);

          if (generatedImages.length >= count) break;
        }
        if (generatedImages.length >= count) break;
      }


      if (generatedImages.length === 0) {
        throw new HttpsError(
          "internal",
          "No images generated. Try a different prompt."
        );
      }

      // 7. Simpan metadata ke Firestore: users/{uid}/generations/{generationId}
      const db = getFirestore();
      const generationsRef = db
        .collection("users")
        .doc(uid)
        .collection("generations");

      const docRef = await generationsRef.add({
        uploadId,
        originalFilePath: originalFilePath,
        generatedPaths: generatedImages,
        prompt: finalPrompt,
        count: generatedImages.length,
        createdAt: new Date(),
        status: "completed",
      });

      logger.info(
        `Generated ${generatedImages.length} images for uid: ${uid}, uploadId: ${uploadId}, generationId: ${docRef.id}`
      );

      return {
        generationId: docRef.id,
        uploadId,
        originalImageUrl: originalDownloadUrl,
        images: generatedImages,
      };
    } catch (error: any) {
      logger.error("generateImages failed", error);
      if (error instanceof HttpsError) throw error;

      const message =
        error?.code === "quota_exceeded"
          ? "Daily AI quota reached. Try again tomorrow."
          : "Generation failed. Please try again.";
      throw new HttpsError("internal", message);
    }
  }
);

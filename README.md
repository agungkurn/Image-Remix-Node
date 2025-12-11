# redraw

Your image. Redrawn.

## Getting Started

This project is built on Firebase Cloud Functions. To get started, you'll need a Firebase project.

1.  **Install Dependencies:**
    Navigate to the `functions` directory and run:
    ```bash
    npm install
    ```

2.  **Set AI API Key:**
    This project uses the Gemini API. Get it from Google AI Studio. You need to store your API key in Google Secret Manager.
    - Create a new secret named `GEMINI_API_KEY`.
    - Set the secret's value to your Gemini API key.

3.  **Deploy:**
    Deploy the function using the Firebase CLI:
    ```bash
    firebase deploy --only functions
    ```

## Architecture

The application is built around a single, powerful Cloud Function (`generateImages`) that handles the entire image generation workflow.

1.  **Trigger:** The process is initiated by an `onCall` HTTPS request from a client application. This provides a secure and straightforward way to pass data to the backend.

2.  **Authentication & Validation:** The function first verifies that the request is made by an authenticated user. It then validates the input to ensure a user can only generate images for their own account.

3.  **Image Retrieval:** The original user-uploaded image is fetched from a dedicated path in Firebase Storage (`users/{uid}/original/{uploadId}.jpg`).

4.  **AI Image Generation:** The core logic resides in the interaction with Google's Gemini API. The function sends the original image along with a text prompt to the `gemini-2.5-flash-image` model, requesting a number of new image variations.

5.  **Storage:** The newly generated images are saved as PNG files back into Firebase Storage under a different user-specific path (`users/{uid}/generated/`).

6.  **Metadata Logging:** A record of the entire transaction is written to Firestore. This document includes paths to the original and generated images, the prompt used, and timestamps. This provides a clear audit trail and allows the client app to easily retrieve the results.

## Security Approach

Security is a primary consideration, addressed through several layers:

1.  **Authentication:** All requests to the `generateImages` function must be authenticated via Firebase Authentication. The function immediately rejects any unauthenticated requests.

2.  **Authorization:** The function implements a critical authorization check to ensure that an authenticated user (`request.auth.uid`) can only generate images associated with their own user ID. This prevents one user from accessing or manipulating another user's data.

3.  **Secret Management:** The `GEMINI_API_KEY` is securely managed using Google Secret Manager. The function is explicitly granted access to this secret, and the key is loaded into the runtime environment via `process.env`. This avoids hardcoding sensitive credentials in the source code.

4.  **Structured Error Handling:** The function includes robust error handling to gracefully manage failures. It catches specific HTTP error codes from the Gemini API, such as `429 (Resource Exhausted)` and `503 (Service Unavailable)`, and translates them into clear, user-friendly error messages for the client.

5.  **Data Isolation:** All user data in Firebase Storage and Firestore is stored in paths that are keyed by the user's unique ID (`uid`). This practice logically segregates data on a per-user basis, forming a foundational layer for security rules and access control.

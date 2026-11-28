import {
  KAGGLE_OWNER,
  KAGGLE_SLUG,
  KAGGLE_SOURCE_VERSION,
} from "./kaggle-etfs.mjs";

const KAGGLE_DOWNLOAD_RPC =
  "https://api.kaggle.com/v1/datasets.DatasetApiService/DownloadDataset";
const KAGGLE_STORAGE_HOSTS = new Set([
  "storage.googleapis.com",
  "storage.cloud.google.com",
]);

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function kaggleFileDownloadUrl(candidate, fetchImpl = fetch) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetchImpl(KAGGLE_DOWNLOAD_RPC, {
        method: "POST",
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ownerSlug: KAGGLE_OWNER,
          datasetSlug: KAGGLE_SLUG,
          fileName: candidate.name,
          datasetVersionNumber: KAGGLE_SOURCE_VERSION,
        }),
      });
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await delay(500 * 2 ** attempt);
      continue;
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location)
        throw new Error("Kaggle file redirect did not include a location.");
      const target = new URL(location, KAGGLE_DOWNLOAD_RPC);
      if (
        target.protocol !== "https:" ||
        !KAGGLE_STORAGE_HOSTS.has(target.hostname)
      )
        throw new Error("Kaggle returned an unapproved storage redirect.");
      return target;
    }

    if ([404, 410].includes(response.status)) {
      await response.body?.cancel();
      throw Object.assign(new Error("Kaggle file is missing."), {
        unsuitable: true,
      });
    }
    if (response.status === 400) {
      await response.body?.cancel();
      throw Object.assign(
        new Error("Kaggle file is unavailable for the pinned version."),
        { unsuitable: true },
      );
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      lastError = new Error(
        `Kaggle temporarily returned HTTP ${response.status}.`,
      );
      if (attempt === 2) break;
      await delay(750 * 2 ** attempt);
      continue;
    }
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403)
      throw new Error(
        `Kaggle denied the cloud request (HTTP ${response.status}).`,
      );
    throw new Error(`Kaggle download RPC returned HTTP ${response.status}.`);
  }

  throw Object.assign(
    new Error(
      `Kaggle cloud request did not recover: ${lastError?.name || "network error"}.`,
      { cause: lastError },
    ),
    { retryable: true },
  );
}

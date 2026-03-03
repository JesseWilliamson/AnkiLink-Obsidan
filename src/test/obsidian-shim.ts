export async function requestUrl(): Promise<never> {
    throw new Error("requestUrl was called without a test mock");
}

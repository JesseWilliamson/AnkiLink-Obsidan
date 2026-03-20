export function requestUrl(): Promise<never> {
    return Promise.reject(new Error("requestUrl was called without a test mock"));
}

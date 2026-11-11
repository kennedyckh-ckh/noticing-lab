export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrapFacilitator } = await import("./lib/bootstrap");
    bootstrapFacilitator();
  }
}

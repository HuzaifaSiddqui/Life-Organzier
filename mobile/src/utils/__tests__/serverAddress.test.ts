import { describe, expect, it } from "vitest";
import { parseServerAddress } from "../serverAddress";

describe("Server address field", () => {
  it("an IP alone gets http and the backend port", () => {
    expect(parseServerAddress("192.168.43.10")).toBe("http://192.168.43.10:5050/api");
    expect(parseServerAddress("  172.20.10.2 ")).toBe("http://172.20.10.2:5050/api");
  });
  it("a port, a scheme or a path is kept / normalised to /api", () => {
    expect(parseServerAddress("192.168.1.5:8080")).toBe("http://192.168.1.5:8080/api");
    expect(parseServerAddress("http://192.168.1.5:5050/api")).toBe("http://192.168.1.5:5050/api");
    expect(parseServerAddress("http://192.168.1.5:5050/")).toBe("http://192.168.1.5:5050/api");
    expect(parseServerAddress("https://api.example.org")).toBe("https://api.example.org/api");
    expect(parseServerAddress("laptop.local")).toBe("http://laptop.local:5050/api");
  });
  it("not an address: null (nothing is saved)", () => {
    for (const bad of ["", "   ", "192.168.1", "300.1.1.1", "ftp://host", "my laptop", "http://", "a..b", ".host"]) expect(parseServerAddress(bad)).toBeNull();
  });
});

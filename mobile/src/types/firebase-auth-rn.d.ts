declare module "firebase/auth" {
  /** RN auth bundle helper; typings omit it when resolving the generic web entry. */
  export function getReactNativePersistence(storage: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
  }): import("@firebase/auth").Persistence;
}

export {};

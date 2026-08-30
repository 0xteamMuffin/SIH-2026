"use client";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

interface AuthContextType {
  token: string | null;
  loading: boolean;
  login: (token: string, refreshToken: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  token: null,
  loading: true,
  login: () => {},
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setToken(localStorage.getItem("token"));
    setLoading(false);
  }, []);

  function login(t: string, refreshToken: string) {
    localStorage.setItem("token", t);
    localStorage.setItem("refreshToken", refreshToken);
    setToken(t);
  }

  function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("refreshToken");
    setToken(null);
  }

  return (
    <AuthContext.Provider value={{ token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

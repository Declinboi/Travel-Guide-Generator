import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

interface User {
  id: string;
  name: string;
  email: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
}

// Helper to safely get token
const getStoredToken = (): string | null => {
  const token = localStorage.getItem("token");
  if (token && token !== "null" && token !== "undefined") {
    return token;
  }
  return null;
};

// Helper to safely get user
const getStoredUser = (): User | null => {
  try {
    const userInfo = localStorage.getItem("userInfo");
    if (userInfo && userInfo !== "null" && userInfo !== "undefined") {
      return JSON.parse(userInfo);
    }
  } catch {
    localStorage.removeItem("userInfo");
  }
  return null;
};

const initialState: AuthState = {
  user: getStoredUser(),
  token: getStoredToken(),
};

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    setCredentials: (
      state,
      action: PayloadAction<{ user: User; token: string }>,
    ) => {
      state.user = action.payload.user;
      state.token = action.payload.token;
      localStorage.setItem("userInfo", JSON.stringify(action.payload.user));
      localStorage.setItem("token", action.payload.token);
    },
    logout: (state) => {
      state.user = null;
      state.token = null;
      localStorage.removeItem("userInfo");
      localStorage.removeItem("token");
    },
  },
});

export const { setCredentials, logout } = authSlice.actions;
export default authSlice.reducer;

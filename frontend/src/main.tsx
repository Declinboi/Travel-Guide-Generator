import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Provider } from "react-redux";
import store from "./redux/store";
import App from "./App";
import "./index.css";

// Pages
import Home from "./pages/Home";
// import CreateBook from "./pages/CreateBook";
// import BookStatus from "./pages/BookStatus";
// import Downloads from "./pages/Downloads";
import PrivateRoute from "./components/PrivateRoute";
import BookStatus from "./pages/BookStatus";
import Downloads from "./pages/Downloads";
import CreateBook from "./pages/CreateBook";
import Profile from "./pages/Profile";
import MyBooks from "./pages/MyBooks";
import Login from "./pages/Auth/Login";
import Register from "./pages/Auth/Register";

function AppRouter() {
  const router = createBrowserRouter([
    {
      path: "/",
      element: <App />,
      children: [
        {
          index: true,
          element: <Home />,
        },
        {
          path: "/login",
          element: <Login />,
        },
        {
          path: "/register",
          element: <Register />,
        },
        {
          path: "/status/:projectId",
          element: <BookStatus />,
        },
        {
          path: "/downloads/:projectId",
          element: <Downloads />,
        },

         { path: "/create", element: <CreateBook /> },
            { path: "/profile", element: <Profile /> },
            { path: "/my-books", element: <MyBooks /> },
        // Protected Routes
        // {
        //   element: <PrivateRoute />,
        //   children: [
        //     { path: "/create", element: <CreateBook /> },
        //     { path: "/profile", element: <Profile /> },
        //     { path: "/my-books", element: <MyBooks /> },
        //   ],
        // },
      ],
    },
  ]);

  return <RouterProvider router={router} />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Provider store={store}>
      <AppRouter />
    </Provider>
  </StrictMode>
);

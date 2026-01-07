import { Navigate, Outlet } from "react-router-dom";
import { useSelector } from "react-redux";

const AdminRoute = () => {
  const { user } = useSelector((state: any) => state.auth);
  return user?.isAdmin ? <Outlet /> : <Navigate to="/" replace />;
};

export default AdminRoute;

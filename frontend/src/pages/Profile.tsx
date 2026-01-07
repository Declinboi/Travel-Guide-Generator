// src/pages/Profile.tsx
import { useSelector } from "react-redux";
import { type RootState } from "../redux/store";

const Profile = () => {
  const { user } = useSelector((state: RootState) => state.auth);

  return (
    <div className="max-w-4xl mx-auto px-4 py-12">
      <h1 className="text-3xl font-bold mb-8">My Profile</h1>

      <div className="bg-white rounded-lg shadow-md p-8">
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Full Name
            </label>
            <p className="text-lg">{user?.name}</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <p className="text-lg">{user?.email}</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Account ID
            </label>
            <p className="text-sm text-gray-600 font-mono">{user?.id}</p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Profile;
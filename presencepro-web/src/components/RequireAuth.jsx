import { Navigate } from "react-router-dom";
import { getUserSession } from "../services/session";

// Wrap any route element with <RequireAuth> to force a logged-in session.
// Pass allowRoles (array) to also restrict which roles may view that route.
export default function RequireAuth({ children, allowRoles }) {
  const session = getUserSession();

  if (!session || !session.user) {
    return <Navigate to="/" replace />;
  }

  if (allowRoles && !allowRoles.includes(session.user.role)) {
    return <Navigate to="/" replace />;
  }

  return children;
}
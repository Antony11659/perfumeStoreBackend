const credentialErrors = new Set([
  "bad_jwt", "invalid_jwt", "session_expired", "session_not_found", "user_not_found",
]);

export function requireErpStaff(getUser) {
  return async function authorize(request, reply) {
    reply.header("Cache-Control", "no-store");
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string"
      ? /^Bearer +([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(authorization)?.[1]
      : undefined;

    function unauthorized() {
      return reply.header("WWW-Authenticate", "Bearer").code(401).send({
        code: "ERP_UNAUTHENTICATED",
        message: "A valid Supabase access token is required.",
      });
    }

    function unavailable() {
      return reply.code(503).send({
        code: "ERP_AUTH_UNAVAILABLE",
        message: "Could not verify ERP authentication.",
      });
    }

    if (!token) return unauthorized();

    let result;
    try {
      result = await getUser(token);
    } catch {
      return unavailable();
    }

    const error = result?.error;
    if (error) {
      if (error.status === 401 || (error.status < 500 && (
        credentialErrors.has(error.code) || error.name === "AuthSessionMissingError"
      ))) return unauthorized();
      return unavailable();
    }

    const user = result?.data?.user;
    if (typeof user?.id !== "string" || !user.id) return unavailable();
    if (user.app_metadata?.erp_staff !== true) {
      return reply.code(403).send({
        code: "ERP_STAFF_REQUIRED",
        message: "ERP staff access is required.",
      });
    }

    request.erpStaff = {
      id: user.id,
      email: typeof user.email === "string" ? user.email : null,
      erpStaff: true,
    };
  };
}

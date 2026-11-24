const name = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" };
const optionalText = { type: "string", nullable: true, maxLength: 200 };
const uuid = { type: "string", format: "uuid" };
const bigint = { type: "string", pattern: "^[1-9][0-9]{0,18}$" };
const gender = { type: "string", enum: ["M", "W", "U"] };
const object = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});
const perfumeFields = { name, brand_id: uuid, gender, fragrance_family: optionalText };
const brandFields = { name, country: optionalText };
const timestamps = {
  created_at: { type: "string", format: "date-time" },
  updated_at: { type: "string", format: "date-time" },
};
const error = (description) => ({
  description, ...object({ code: { type: "string" }, message: { type: "string" } }),
});

function schema({ kind, create, fields, required }) {
  const perfume = kind === "perfume";
  const id = perfume ? bigint : uuid;
  const shape = perfume
    ? object({ id, ...perfumeFields, gender: { type: "string", nullable: true }, ...timestamps })
    : object({ id, ...brandFields, ...timestamps });

  return {
    tags: ["ERP"],
    summary: `${create ? "Create" : "Update"} ERP ${kind}`,
    security: [{ erpBearer: [] }],
    ...(!create && { params: object({ id }) }),
    body: { ...object(fields, required), minProperties: 1 },
    response: {
      [create ? 201 : 200]: shape,
      400: error("Invalid fields, identifier, or volume selection"),
      401: error("A valid bearer token is required"),
      403: error("ERP staff access required"),
      ...(perfume || !create ? { 404: error("Perfume or brand does not exist") } : {}),
      409: error("Duplicate name, identity dependency, or concurrent edit"),
      503: error("Authentication or database service unavailable"),
    },
  };
}

function normalize(body) {
  const data = { ...body };
  if ("name" in data) data.name = data.name.trim();
  for (const key of ["country", "fragrance_family"]) {
    if (key in data) data[key] = data[key]?.trim() || null;
  }
  return data;
}

function failure(error, reply, kind) {
  switch (error.code) {
    case "23505":
      return reply.code(409).send({
        code: "ERP_CATALOG_DUPLICATE",
        message: kind === "brand" ? "A brand with this name already exists." : "A perfume with this name already exists for this brand.",
      });
    case "P0001":
      return reply.code(409).send({
        code: "ERP_CATALOG_DEPENDENCY",
        message: "Existing orders or marketplace mappings prevent changing this identity. You can still edit other fields.",
      });
    case "40P01":
    case "40001":
      return reply.code(409).send({ code: "ERP_CATALOG_CONCURRENT_EDIT", message: "This record was busy. Try saving again." });
    case "22023":
      return reply.code(400).send({ code: "ERP_INVALID_VOLUMES", message: "Select distinct registered volumes." });
    case "23503":
      return reply.code(404).send({ code: "ERP_BRAND_NOT_FOUND", message: "Brand not found." });
    case "P0002":
      return reply.code(404).send({ code: "ERP_CATALOG_NOT_FOUND", message: kind === "brand" ? "Brand not found." : "Perfume not found." });
    default:
      return reply.code(503).send({ code: "ERP_CATALOG_UNAVAILABLE", message: "Catalog saving is unavailable." });
  }
}

export default async function erpCatalogWriteRoutes(fastify, { db }) {
  function register(method, kind, fields, required, write) {
    const create = method === "POST";
    fastify.route({
      method,
      url: `/${kind}s${create ? "" : "/:id"}`,
      schema: schema({ kind, create, fields, required }),
      async preValidation(request, reply) {
        if (request.body && Object.keys(request.body).some((key) => !Object.hasOwn(fields, key))) {
          return reply.code(400).send({ code: "ERP_INVALID_FIELDS", message: "The request contains unsupported fields." });
        }
      },
      async handler(request, reply) {
        const id = request.params?.id;
        if (kind === "perfume" && id && BigInt(id) > 9223372036854775807n) {
          return reply.code(400).send({ code: "ERP_INVALID_ID", message: "Invalid perfume ID." });
        }
        try {
          const { data, error } = await write(normalize(request.body), id);
          if (data && !error) return reply.code(create ? 201 : 200).send(data);
          return failure(error ?? {}, reply, kind);
        } catch {
          request.log.warn({ event: "erp_catalog_write_failed", resource: kind });
          return failure({}, reply, kind);
        }
      },
    });
  }

  register("POST", "perfume", {
    ...perfumeFields,
    volumes: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: { type: "integer", minimum: 1, maximum: 32767 } },
  }, ["name", "brand_id", "gender", "volumes"], (body) => db.rpc("erp_create_perfume_v1", {
    p_name: body.name, p_brand_id: body.brand_id, p_gender: body.gender,
    p_fragrance_family: body.fragrance_family ?? null, p_volumes: body.volumes,
  }));

  register("PATCH", "perfume", { ...perfumeFields, gender: { anyOf: [gender, { type: "null" }] } }, [],
    (body, id) => db.rpc("erp_update_perfume_v1", { p_id: id, p_patch: body }));
  register("POST", "brand", brandFields, ["name"], (body) =>
    db.rpc("erp_create_brand_v1", { p_name: body.name, p_country: body.country ?? null }));
  register("PATCH", "brand", brandFields, [], (body, id) => db.rpc("erp_update_brand_v1", { p_id: id, p_patch: body }));
}

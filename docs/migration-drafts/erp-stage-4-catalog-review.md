# Stage 4 catalog migration review

The draft assumes the Stage 2 catalog, variant, SKU and deletion RPCs are present. Verify production RPC definitions, grants, unique keys and inbound foreign keys before applying. The draft adds an update cascade to the reviewed SKU-to-variant foreign key and keeps its delete rule. It keeps website order IDs, variant references, pricing and quantities in place.

The existing matching screen combines marketplace results with persisted detached identities. The previous list derived unmatched SKUs from visible products with no mapping. The private collection retains mapping ID, SKU and shop when a product is detached, including products outside the latest sync. Its triggers enforce SKU uniqueness across mapped and detached records, including writes by the existing catalog SKU endpoint. Confirm the service role has the privileges required by the replacement RPCs, including deletion on the mapped SKU table.

Historical website order references, registered images and publication reservations prevent hard deletion. Website payment and delivery consumers still use the live order-to-variant relationship. The image publication draft can coexist with this draft.

Apply the reviewed catalog SQL before enabling the new ERP backend and frontend. A rollback plan must account for detached SKU identities created after activation. Preserve and reconcile them before attempting to remove the detached collection.

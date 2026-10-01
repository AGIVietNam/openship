import { Type, type Static } from "@sinclair/typebox";

const id = Type.String({ minLength: 1, maxLength: 128 });
const nullableNumber = Type.Union([Type.Number({ minimum: 0 }), Type.Null()]);
const meter = Type.Object({ used: Type.Number({ minimum: 0 }), max: nullableNumber });
export const CloudAllocationSchema = Type.Object({
  cpuCores: Type.Number({ minimum: 0.25, maximum: 1024 }),
  memoryMb: Type.Integer({ minimum: 128, maximum: 1048576 }),
  diskMb: Type.Integer({ minimum: 0, maximum: 1073741824 }),
});
export const CloudCapacityPoolSchema = Type.Object({
  cpuCores: meter,
  memoryMb: meter,
  diskMb: meter,
  workspaces: meter,
});
export const CloudCapacityServiceSchema = Type.Object({
  id,
  name: Type.String(),
  resources: CloudAllocationSchema,
});
export const CloudCapacityProjectSchema = Type.Object({
  id,
  name: Type.String(),
  revision: Type.String(),
  allocation: Type.Union([CloudAllocationSchema, Type.Null()]),
  services: Type.Array(CloudCapacityServiceSchema),
  editable: Type.Boolean(),
  unavailableReason: Type.Union([Type.String(), Type.Null()]),
  activeAdjustmentId: Type.Union([id, Type.Null()]),
});
export const CloudCapacityOverviewSchema = Type.Object({
  pool: CloudCapacityPoolSchema,
  projects: Type.Array(CloudCapacityProjectSchema),
  serviceLimit: Type.Union([
    Type.Pick(CloudAllocationSchema, ["cpuCores", "memoryMb"]),
    Type.Null(),
  ]),
  measuredAt: Type.String(),
});
export const CloudCapacityEditSchema = Type.Object(
  {
    projectId: id,
    revision: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    services: Type.Array(
      Type.Object(
        {
          serviceId: id,
          cpuCores: CloudAllocationSchema.properties.cpuCores,
          memoryMb: CloudAllocationSchema.properties.memoryMb,
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 128 },
    ),
  },
  { additionalProperties: false },
);
export const CloudCapacityPreviewSchema = Type.Object({
  projectId: id,
  projectName: Type.String(),
  revision: Type.String(),
  before: CloudAllocationSchema,
  after: CloudAllocationSchema,
  restartServices: Type.Array(Type.String()),
  services: Type.Array(CloudCapacityServiceSchema),
});
export const ApplyCloudCapacitySchema = Type.Object(
  {
    ...CloudCapacityEditSchema.properties,
    idempotencyKey: Type.String({ minLength: 16, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
    confirmRestart: Type.Literal(true),
  },
  { additionalProperties: false },
);
export type CloudCapacityOverview = Static<typeof CloudCapacityOverviewSchema>;
export type CloudCapacityProject = Static<typeof CloudCapacityProjectSchema>;
export type CloudCapacityEdit = Static<typeof CloudCapacityEditSchema>;
export type CloudCapacityPreview = Static<typeof CloudCapacityPreviewSchema>;

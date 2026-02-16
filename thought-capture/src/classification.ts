export type Classification = "action_required" | "reference" | "noise";

const VALID_CLASSIFICATIONS: readonly Classification[] = [
  "action_required",
  "reference",
  "noise",
];

const CLASSIFICATION_LABELS: Record<Classification, string> = {
  action_required: "Action Required",
  reference: "Reference",
  noise: "Noise",
};

export function isClassification(value: string): value is Classification {
  return (VALID_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function toClassificationLabel(classification: Classification): string {
  return CLASSIFICATION_LABELS[classification];
}

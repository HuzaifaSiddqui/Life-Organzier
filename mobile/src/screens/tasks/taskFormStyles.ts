import { StyleSheet } from "react-native";
import { colors, radii, shadow } from "../../constants/theme";

export const TASK_FIELD_INPUT_HEIGHT = 56;

const inputBase = {
  borderWidth: 1,
  borderColor: colors.border,
  borderRadius: radii.md,
  paddingHorizontal: 16,
  fontSize: 16,
  backgroundColor: colors.surface,
  color: colors.text,
};

export const taskFormStyles = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.xl,
    padding: 24,
    ...shadow,
  },
  field: {
    marginBottom: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: "500",
    color: colors.text,
    marginBottom: 8,
  },
  input: {
    ...inputBase,
    height: TASK_FIELD_INPUT_HEIGHT,
  },
  multilineInput: {
    ...inputBase,
    minHeight: 112,
    paddingTop: 14,
    paddingBottom: 14,
    textAlignVertical: "top",
  },
  fieldError: {
    color: "#b91c1c",
    marginTop: 6,
    fontSize: 13,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 4,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: colors.surface,
  },
  chipActive: {
    borderColor: colors.primary,
    backgroundColor: "#EEF7FF",
  },
  chipText: {
    color: colors.text,
    fontWeight: "600",
    fontSize: 13,
  },
  chipTextActive: {
    color: "#0065C3",
  },
  sectionLabel: {
    fontSize: 14,
    fontWeight: "500",
    color: colors.text,
    marginBottom: 10,
    marginTop: 8,
  },
  error: {
    color: "#b91c1c",
    marginBottom: 12,
    fontSize: 14,
    lineHeight: 20,
  },
});

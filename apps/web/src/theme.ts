import {
  createTheme,
  Button,
  NativeSelect,
  TextInput,
  NumberInput,
  Modal,
  Drawer,
} from "@mantine/core";

export const hospitalTheme = createTheme({
  primaryColor: "blue",
  defaultRadius: "sm",
  fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
  fontSizes: {
    xs: "0.75rem",
    sm: "0.875rem",
    md: "0.875rem",
    lg: "1rem",
    xl: "1.125rem",
  },
  headings: {
    fontFamily: '"IBM Plex Sans", "Segoe UI", sans-serif',
    fontWeight: "600",
  },
  focusRing: "auto",
  components: {
    Button: Button.extend({ defaultProps: { size: "sm", fw: 500 } }),
    NativeSelect: NativeSelect.extend({ defaultProps: { size: "sm" } }),
    TextInput: TextInput.extend({ defaultProps: { size: "sm" } }),
    NumberInput: NumberInput.extend({ defaultProps: { size: "sm" } }),
    Modal: Modal.extend({
      defaultProps: {
        centered: true,
        overlayProps: { backgroundOpacity: 0.25, blur: 2 },
        transitionProps: { duration: 120 },
      },
    }),
    Drawer: Drawer.extend({
      defaultProps: {
        position: "right",
        overlayProps: { backgroundOpacity: 0.22 },
        transitionProps: { duration: 150 },
      },
    }),
  },
});

import { createFileRoute } from "@tanstack/react-router";
import { HabitatLandingPage } from "@/features/habitat/ui/HabitatLandingPage";

export const Route = createFileRoute("/")({
  component: HabitatLandingPage,
});

import { useLocalSearchParams } from "expo-router";
import { MobileBotWorkbench } from "@/components/MobileBotWorkbench";

export default function MobileBotsScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>();
  return <MobileBotWorkbench hostId={hostId} embedded={false} />;
}

import { Suspense } from "react";
import HarvestClient from "./HarvestClient";

export const metadata = { title: "Harvest" };

export default function HarvestPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>Loading harvest…</div>}>
      <HarvestClient />
    </Suspense>
  );
}

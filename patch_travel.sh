#!/bin/bash
sed -i 's/vehicleId: selectedVehicle?.id,/...(selectedVehicle ? { vehicleId: selectedVehicle.id, vehicleName: selectedVehicle.name } : {}),/g' src/components/survival/BuildingDetailModal.tsx
sed -i '/vehicleName: selectedVehicle?.name,/d' src/components/survival/BuildingDetailModal.tsx

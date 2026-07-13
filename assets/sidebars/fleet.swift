func fleetSeatAge(_ createdAtEpoch, _ nowEpoch) -> String {
  let age = max(0, nowEpoch - createdAtEpoch)
  if age < 60 { return "seat <1m" }
  if age < 3600 { return "seat \(age / 60)m" }
  if age < 86400 { return "seat \(age / 3600)h" }
  return "seat \(age / 86400)d"
}

func fleetState(_ state) -> some View {
  HStack(spacing: 4) {
    if state == "working" {
      Text("●").foregroundColor("#3B82F6")
      Text("working").foregroundColor("#3B82F6")
    } else {
      if state == "idle" {
        Text("●").foregroundColor("#6B7280")
        Text("idle").foregroundColor("#6B7280")
      } else {
        Text("●").foregroundColor("#EF4444")
        Text("stalled").foregroundColor("#EF4444")
      }
    }
  }
  .font(.system(size: 9, design: .monospaced))
}

func fleetRow(_ seat) -> some View {
  Button(action: { cmux("surface.focus", surface_id: seat.surfaceRef) }) {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        fleetState(seat.screenState)
        Text(seat.name).font(.system(size: 12)).fontWeight(seat.role == "lead" ? .semibold : .regular)
        Spacer()
        Text(fleetSeatAge(seat.createdAtEpoch, clock.epoch))
          .font(.system(size: 9, design: .monospaced))
          .foregroundColor(.tertiary)
      }
      Text(seat.status)
        .font(.system(size: 10))
        .foregroundColor(seat.statusMissing ? "#EF4444" : .secondary)
      if seat.healthStatus != "healthy" {
        Text("health: \(seat.health)")
          .font(.system(size: 9))
          .foregroundColor(seat.healthStatus == "unhealthy" ? "#EF4444" : "#F59E0B")
      }
    }
    .padding(6)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background {
      RoundedRectangle(cornerRadius: 6)
        .foregroundColor(seat.role == "lead" ? "#3B82F6" : "#6B7280")
        .opacity(seat.role == "lead" ? 0.10 : 0.05)
    }
  }
}

func fleetLane(_ name, _ liveCount, _ activeCount, _ collapsed, _ seats) -> some View {
  VStack(alignment: .leading, spacing: 3) {
    HStack(spacing: 6) {
      Text(name).font(.system(size: 11)).fontWeight(.semibold)
      Spacer()
      Text("\(liveCount) live · \(activeCount) active")
        .font(.system(size: 9, design: .monospaced))
        .foregroundColor(.secondary)
    }
    .padding(4)
    if collapsed {
      Text("\(liveCount) idle seats collapsed")
        .font(.system(size: 9))
        .foregroundColor(.tertiary)
        .padding(4)
    } else {
      ForEach(seats) { seat in
        fleetRow(seat)
      }
    }
  }
}

ScrollView {
VStack(alignment: .leading, spacing: 6) {
  HStack {
    Text("Fleet").font(.system(size: 13)).bold()
    Spacer()
    Text("0 live seats · 0 active")
      .font(.system(size: 9, design: .monospaced))
      .foregroundColor(.secondary)
  }
  .padding(4)
  Divider()
  Text("No live fleet seats")
    .font(.system(size: 11))
    .foregroundColor(.secondary)
    .padding(6)
  Spacer()
}
}

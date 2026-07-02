# Gaming Engine Service

## Purpose

Gaming Engine is a generic engine service for producing unbiased engine results. The current baseline supports number-set draws only. It does not contain game-specific rules for Keno, Happy 8, PK10, settlement, database persistence, or message-broker integration.

## Architecture

The service uses a clean architecture layout:

- `src/GamingEngine.Domain`: domain models and abstractions, including `IRandomNumberGenerator`.
- `src/GamingEngine.Application`: engine use cases, including `NumberSetEngine`.
- `src/GamingEngine.Infrastructure`: infrastructure implementations, including `CryptoRandomNumberGenerator`.
- `src/GamingEngine.Api`: ASP.NET Core Web API endpoints, health checks, structured logging, and Swagger.
- `tests/GamingEngine.Tests`: xUnit unit and integration-style API tests.

## Build

```bash
dotnet build GamingEngine.sln
```

Run from `services/gaming-engine`.

## Test

```bash
dotnet test GamingEngine.sln
```

The service is pinned to .NET 8 through `global.json`; install the .NET 8 SDK locally or run the commands in a .NET 8 SDK container.

## Run Locally

```bash
dotnet run --project src/GamingEngine.Api/GamingEngine.Api.csproj
```

Health endpoints:

- `GET /health`
- `GET /health/live`
- `GET /health/ready`

Number-set draw endpoint:

```bash
curl -X POST http://localhost:5000/api/engines/number-set/draw \
  -H "Content-Type: application/json" \
  -d '{"minNumber":1,"maxNumber":10,"numbersToDraw":5,"correlationId":"local-test"}'
```

Swagger is available at `/swagger`.

## Docker

Build the image from the repository root:

```bash
docker build -t lottery-gaming-engine:local services/gaming-engine
```

Run:

```bash
docker run --rm -p 5600:8080 lottery-gaming-engine:local
```

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build

WORKDIR /src

COPY GameEngine.sln ./
COPY src/GameEngine.Api/GameEngine.Api.csproj src/GameEngine.Api/
COPY src/GameEngine.Application/GameEngine.Application.csproj src/GameEngine.Application/
COPY src/GameEngine.Domain/GameEngine.Domain.csproj src/GameEngine.Domain/
COPY src/GameEngine.Infrastructure/GameEngine.Infrastructure.csproj src/GameEngine.Infrastructure/
COPY src/GameEngine.Modules/GameEngine.Modules.csproj src/GameEngine.Modules/
RUN dotnet restore src/GameEngine.Api/GameEngine.Api.csproj

COPY . .
RUN dotnet publish src/GameEngine.Api/GameEngine.Api.csproj \
  --configuration Release \
  --output /app/publish \
  --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime

WORKDIR /app

ENV ASPNETCORE_URLS=http://+:8080
ENV DOTNET_RUNNING_IN_CONTAINER=true

COPY --from=build /app/publish .

EXPOSE 8080

ENTRYPOINT ["dotnet", "GameEngine.Api.dll"]

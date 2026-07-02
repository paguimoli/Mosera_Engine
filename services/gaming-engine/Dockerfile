FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build

WORKDIR /src

COPY GamingEngine.sln ./
COPY src/GamingEngine.Api/GamingEngine.Api.csproj src/GamingEngine.Api/
COPY src/GamingEngine.Application/GamingEngine.Application.csproj src/GamingEngine.Application/
COPY src/GamingEngine.Domain/GamingEngine.Domain.csproj src/GamingEngine.Domain/
COPY src/GamingEngine.Infrastructure/GamingEngine.Infrastructure.csproj src/GamingEngine.Infrastructure/
COPY tests/GamingEngine.Tests/GamingEngine.Tests.csproj tests/GamingEngine.Tests/
RUN dotnet restore src/GamingEngine.Api/GamingEngine.Api.csproj

COPY . .
RUN dotnet publish src/GamingEngine.Api/GamingEngine.Api.csproj \
  --configuration Release \
  --output /app/publish \
  --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0 AS runtime

WORKDIR /app

ENV ASPNETCORE_URLS=http://+:8080
ENV DOTNET_RUNNING_IN_CONTAINER=true

COPY --from=build /app/publish .

EXPOSE 8080

ENTRYPOINT ["dotnet", "GamingEngine.Api.dll"]
